import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as ToolTasks from '@deepseek-ai/dsh-tool-jobs'
import LocalActivityRegistry from '@deepseek-ai/dsh-activity-local'
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
  await ctx.plugin(LocalActivityRegistry)
  await ctx.plugin(BashEnvPlugin)
  await ctx.plugin(FakePwsh)
  await ctx.plugin(ToolPwsh, { activityPollMs: 5 })
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

describe('background pwsh observation', () => {
  it('mirrors observed streams with channels and settles with the mapped outcome', async () => {
    const { ctx, pwsh } = await setup()
    const stdout = { text: '' }
    const stderr = { text: '' }
    const scripted = observableProcess({ stdout, stderr })
    pwsh.backgroundHandler = () => scripted.proc

    await call(ctx, { command: 'Get-Progress', description: 'test command', run_in_background: true })
    const job = ctx.jobs.list()[0]
    const row = await until(() => ctx.activities.list().find(item => item.correlation?.jobId === job!.id))
    expect(row.kind).toBe('pwsh')

    stdout.text = 'progress-line\n'
    stderr.text = 'warn-line\n'
    await until(() => {
      const chunks = ctx.activities.read(row.id, 0).chunks
      return chunks.some(chunk => chunk.text.includes('progress-line'))
        && chunks.some(chunk => chunk.text.includes('warn-line'))
        ? true
        : undefined
    })
    const chunks = ctx.activities.read(row.id, 0).chunks
    expect(chunks.find(chunk => chunk.text.includes('progress-line'))?.channel).toBe('stdout')
    expect(chunks.find(chunk => chunk.text.includes('warn-line'))?.channel).toBe('stderr')

    scripted.finish()
    await until(() => ctx.activities.get(row.id).status === 'completed' ? true : undefined)
    expect(ctx.activities.get(row.id).detail).toBe('exit code: 0')
  })

  it('a pump failure waits for process settlement before mapping the outcome', async () => {
    const { ctx, pwsh } = await setup()
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
    const row = await until(() => ctx.activities.list()[0])
    // The pump rejected on its first poll; the still-running process must not
    // be mapped to a terminal state until it actually settles.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(ctx.activities.list()[0]?.status).toBe('running')
    proc.status = 'completed'
    proc.exitCode = 0
    resolveDone()
    await until(() => ctx.activities.list()[0]?.status !== 'running' ? true : undefined)
    expect(ctx.activities.list()[0]).toMatchObject({ status: 'completed', detail: 'exit code: 0' })
    expect(String(row.id)).toContain('pwsh')
  })

  it('a throwing end() is swallowed by the settlement-mapping catch', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalJobRegistry)
    await ctx.plugin(ToolTasks)
    await ctx.plugin({
      name: 'end-throwing-activities-probe',
      apply(child: Context) {
        child.provide('activities', {
          open: () => ({
            id: 'pwsh-1',
            append() {},
            updateDetail() {},
            end() { throw new Error('end boom') },
          }),
        })
      },
    })
    await ctx.plugin(BashEnvPlugin)
    await ctx.plugin(FakePwsh)
    await ctx.plugin(ToolPwsh, { activityPollMs: 5 })
    const pwsh = ctx.shell as FakePwsh
    const warn = vi.fn()
    ctx.logger.warn = warn as never
    const handle = observableProcess({ stdout: { text: '' }, stderr: { text: '' } })
    pwsh.backgroundHandler = () => handle.proc
    await call(ctx, { command: 'Get-Doom', description: 'test command', run_in_background: true })
    handle.finish()
    await until(() => warn.mock.calls.some(args => String(args[0]).includes('activity settlement mapping')) ? true : undefined)
  })

  it('a backend without observed readers still yields a status-only process', async () => {
    const { ctx, pwsh } = await setup()
    const scripted = observableProcess()
    pwsh.backgroundHandler = () => scripted.proc

    await call(ctx, { command: 'Start-Job', description: 'test command', run_in_background: true })
    const job = ctx.jobs.list()[0]
    const row = await until(() => ctx.activities.list().find(item => item.correlation?.jobId === job!.id))
    expect(ctx.activities.read(row.id, 0).chunks).toEqual([])

    scripted.finish()
    await until(() => ctx.activities.get(row.id).status === 'completed' ? true : undefined)
    expect(ctx.activities.get(row.id).outputTotal).toBe(0)
  })
})
