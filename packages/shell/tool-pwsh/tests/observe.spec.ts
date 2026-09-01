import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as ToolTasks from '@deepseek-ai/dsh-tool-jobs'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import * as ToolPwsh from '@deepseek-ai/dsh-tool-pwsh'
import * as BashEnvPlugin from '@deepseek-ai/dsh-shell-env'

const testToolSignal = new AbortController().signal

/** ASCII-only scripted stream: readFrom offsets are byte-exact string indexes. */
function scriptedReader(state: { text: string }) {
  return {
    readFrom(fromByte: number) {
      return { text: state.text.slice(fromByte), nextOffset: state.text.length, lossy: false }
    },
  }
}

/** A running fake background handle with optional non-consuming observed streams. */
function observableProcess(streams?: { stdout: { text: string }; stderr: { text: string } }) {
  let resolveDone: () => void = () => {}
  const done = new Promise<void>((resolve) => { resolveDone = resolve })
  const proc: ShellProcess = {
    status: 'running',
    exitCode: null,
    signal: null,
    done,
    readOutput: () => ({ delta: '', lossy: false }),
    kill: () => false,
    ...streams !== undefined
      ? { observed: { stdout: scriptedReader(streams.stdout), stderr: scriptedReader(streams.stderr) } }
      : {},
  }
  return {
    proc,
    finish() {
      proc.status = 'completed'
      proc.exitCode = 0
      resolveDone()
    },
  }
}

class FakePwsh extends ShellExecutor {
  backgroundHandler: (spec: ShellExecSpec) => ShellProcess = () => { throw new Error('unscripted start') }

  override resolve(request: ShellExecRequest): ShellExecSpec {
    return {
      command: request.command,
      workdir: request.workdir ?? process.cwd(),
      timeoutMs: request.timeoutMs ?? 60_000,
      stdoutMaxBytes: request.stdoutMaxBytes ?? 64_000,
      ...request.signal ? { signal: request.signal } : {},
      ...request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {},
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  override async run(): Promise<ShellRunResult> {
    throw new Error('foreground is not exercised here')
  }

  override start(spec: ShellExecSpec): ShellProcess {
    return this.backgroundHandler(spec)
  }
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry)
  await ctx.plugin(ToolTasks)
  await ctx.plugin(BashEnvPlugin)
  await ctx.plugin(FakePwsh)
  await ctx.plugin(ToolPwsh, { recordPollMs: 5 })
  return { ctx, pwsh: ctx.shell as FakePwsh }
}

let callCounter = 0
function call(ctx: Context, args: Record<string, unknown>) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`pwsh-observe-${++callCounter}`),
    name: 'pwsh',
    arguments: args,
  })
}

async function until<T>(read: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = read()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('condition not reached before timeout')
}

describe('background pwsh record', () => {
  it('streams observed channels into the job record and settles with the mapped outcome', async () => {
    const { ctx, pwsh } = await setup()
    const stdout = { text: '' }
    const stderr = { text: '' }
    const scripted = observableProcess({ stdout, stderr })
    pwsh.backgroundHandler = () => scripted.proc

    await call(ctx, { command: 'Get-Progress', description: 'test command', run_in_background: true })
    const job = ctx.jobs.list()[0]
    expect(job).toBeDefined()
    expect(job!.kind).toBe('pwsh')
    expect(job!.outputTotal).toBe(0)

    stdout.text = 'progress-line\n'
    stderr.text = 'warn-line\n'
    await until(() => {
      const chunks = ctx.jobs.readRecord(job!.id, 0).chunks
      return chunks.some(chunk => chunk.text.includes('progress-line'))
        && chunks.some(chunk => chunk.text.includes('warn-line'))
        ? true
        : undefined
    })
    const chunks = ctx.jobs.readRecord(job!.id, 0).chunks
    expect(chunks.find(chunk => chunk.text.includes('progress-line'))?.channel).toBe('stdout')
    expect(chunks.find(chunk => chunk.text.includes('warn-line'))?.channel).toBe('stderr')

    scripted.finish()
    await until(() => ctx.jobs.get(job!.id).status === 'completed' ? true : undefined)
    expect(ctx.jobs.get(job!.id).detail).toBe('exit code: 0')
  })

  it('a pump failure warns and never fakes a terminal state onto the running job', async () => {
    const { ctx, pwsh } = await setup()
    const warn = vi.fn()
    ctx.logger.warn = warn as never
    let resolveDone: () => void = () => {}
    const done = new Promise<void>((resolve) => { resolveDone = resolve })
    const proc: ShellProcess = {
      status: 'running',
      exitCode: null,
      signal: null,
      done,
      readOutput: () => ({ delta: '', lossy: false }),
      kill: () => false,
      observed: {
        stdout: { readFrom() { throw new Error('reader boom') } },
        stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
      },
    }
    pwsh.backgroundHandler = () => proc
    await call(ctx, { command: 'Get-Broken', description: 'test command', run_in_background: true })
    const job = ctx.jobs.list()[0]
    await until(() => warn.mock.calls.some(args => String(args[0]).includes('record observation pump')) ? true : undefined)
    // The pump already failed; the job must wait for real settlement rather
    // than freezing a fake terminal state onto the running process.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(ctx.jobs.get(job!.id).status).toBe('running')
    proc.status = 'completed'
    proc.exitCode = 0
    resolveDone()
    await until(() => ctx.jobs.get(job!.id).status !== 'running' ? true : undefined)
    expect(ctx.jobs.get(job!.id)).toMatchObject({ status: 'completed', detail: 'exit code: 0' })
  })

  it('a backend without observed readers still yields a status-only record', async () => {
    const { ctx, pwsh } = await setup()
    const scripted = observableProcess()
    pwsh.backgroundHandler = () => scripted.proc

    await call(ctx, { command: 'Start-Job', description: 'test command', run_in_background: true })
    const job = ctx.jobs.list()[0]
    expect(ctx.jobs.readRecord(job!.id, 0).chunks).toEqual([])

    scripted.finish()
    await until(() => ctx.jobs.get(job!.id).status === 'completed' ? true : undefined)
    expect(ctx.jobs.get(job!.id).outputTotal).toBe(0)
  })
})

describe('owned background record (pwsh)', () => {
  it('keeps an owned background run record under the owning session', async () => {
    const { ctx, pwsh } = await setup()
    const owner = {
      id: SessionId('pwsh-observe-owner'),
      session: { id: SessionId('pwsh-observe-owner'), header: { cwd: process.cwd() } },
      status: 'idle',
      ctx,
    } as unknown as Agent
    ctx.agents.register(owner)
    const scripted = observableProcess()
    pwsh.backgroundHandler = () => scripted.proc
    await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('pwsh-observe-owned'),
      name: 'pwsh',
      arguments: { command: 'Get-Slow', description: 'test command', run_in_background: true },
      agent: owner,
    })
    const job = ctx.jobs.list(owner)[0]
    expect(job).toBeDefined()
    expect(job!.ownerSession).toBe(owner.id)
    expect(() => ctx.jobs.readRecord(job!.id, 0)).toThrow(/belongs to another session/)
    expect(ctx.jobs.readRecord(job!.id, 0, owner).chunks).toEqual([])
    scripted.finish()
    await until(() => ctx.jobs.get(job!.id, owner).status === 'completed' ? true : undefined)
  })
})
