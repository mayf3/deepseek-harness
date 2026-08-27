import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as ToolTasks from '@deepseek-ai/dsh-tool-jobs'
import LocalActivityRegistry from '@deepseek-ai/dsh-activity-local'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellExecution, ShellProcess } from '@deepseek-ai/dsh-shell'
import * as ToolPwsh from '@deepseek-ai/dsh-tool-pwsh'
import { renderPwshPromoted } from '../src/render.ts'
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
  foregroundHandler: (spec: ShellExecSpec) => ShellExecution = () => { throw new Error('foreground is not exercised here') }

  override resolve(request: ShellExecRequest): ShellExecSpec {
    return {
      command: request.command,
      workdir: request.workdir ?? process.cwd(),
      timeoutMs: request.timeoutMs ?? 60_000,
      onExpiry: request.onExpiry ?? 'kill',
      stdoutMaxBytes: request.stdoutMaxBytes ?? 64_000,
      ...request.signal ? { signal: request.signal } : {},
      ...request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {},
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  override execute(spec: ShellExecSpec): ShellExecution {
    if (spec.onExpiry !== 'none') return this.foregroundHandler(spec)
    // Augment the scripted handle in place: the scenarios mutate the original
    // object (finish()), so a spread copy would freeze its lifecycle.
    return Object.assign(this.backgroundHandler(spec), {
      promotion: Promise.resolve(undefined),
      result: () => Promise.reject(new Error('foreground projection unused')),
    })
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

describe('foreground timeout promotion (pwsh)', () => {
  /** A scriptable still-running execution whose deadline already offered. */
  function promotableExecution(partial: string) {
    const offer = {
      accepted: false,
      declined: false,
      accept() { this.accepted = true },
      decline() { this.declined = true },
    }
    let settle: () => void = () => {}
    let consumed = false
    const proc = {
      status: 'running',
      exitCode: null,
      signal: null,
      done: new Promise<void>((resolve) => {
        settle = () => {
          proc.status = 'completed'
          proc.exitCode = 0
          resolve()
        }
      }),
      readOutput: () => {
        const delta = consumed ? '' : partial
        consumed = true
        return { delta, lossy: false }
      },
      kill: () => false,
      promotion: Promise.resolve(offer),
      result: () => Promise.reject(new Error('result projection unused after promotion')),
    } as unknown as ShellExecution & { status: string; exitCode: number | null }
    return { proc, offer, finish: () => { settle() } }
  }

  it('moves a timed-out command into a pwsh job carrying the output so far', async () => {
    const { ctx, pwsh } = await setup()
    const scripted = promotableExecution('early-output\n')
    pwsh.foregroundHandler = () => scripted.proc

    const result = await call(ctx, { command: 'Get-Slow', description: 'test command', timeoutMs: 250 })
    const body = (result.content[0] as { text: string }).text
    expect(body).toContain('early-output')
    expect(body).toContain('moved to background job pwsh-1]')
    expect(body).toContain('read newer output with job_output, stop it with job_kill')
    expect(scripted.offer.accepted).toBe(true)

    const job = ctx.jobs.list()[0]
    expect(job).toMatchObject({ id: 'pwsh-1', kind: 'pwsh', status: 'running' })
    // The consuming cursor continued past the promoted output.
    expect(ctx.jobs.read(job!.id).text).toBe('')
    scripted.finish()
    await until(() => ctx.jobs.get(job!.id).status === 'completed' ? true : undefined)
  })

  it('declines the offer and reports the timeout when no job controller serves the owner', async () => {
    // The same composition minus dsh-tool-jobs: the registry exists, so the
    // deadline still offers, but admission refuses and the tool falls back.
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalJobRegistry)
    await ctx.plugin(BashEnvPlugin)
    await ctx.plugin(FakePwsh)
    await ctx.plugin(ToolPwsh, { activityPollMs: 5 })
    const pwsh = ctx.shell as FakePwsh
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const scripted = promotableExecution('')
    Object.assign(scripted.proc, {
      result: () => Promise.resolve({
        exitCode: 1,
        signal: null,
        timedOut: true,
        aborted: false,
        timeoutMs: 250,
        stdout: { text: '', truncated: false },
        stderr: { text: '', truncated: false },
      }),
    })
    pwsh.foregroundHandler = () => scripted.proc

    const result = await call(ctx, { command: 'Get-Slow', description: 'test command', timeoutMs: 250 })
    const body = (result.content[0] as { text: string }).text
    expect(body).toContain('[timed out after 250ms]')
    expect(body).not.toContain('moved to background job')
    expect(scripted.offer.declined).toBe(true)
    expect(warn.mock.calls.map(args => String(args[0])).join('\n')).toContain('timeout promotion unavailable')
  })

  it('keeps the kill deadline and the plain description when promotion is off', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalJobRegistry)
    await ctx.plugin(ToolTasks)
    await ctx.plugin(BashEnvPlugin)
    await ctx.plugin(FakePwsh)
    await ctx.plugin(ToolPwsh, { promoteOnTimeout: false })
    const pwsh = ctx.shell as FakePwsh
    const specs: ShellExecSpec[] = []
    pwsh.foregroundHandler = (spec) => {
      specs.push(spec)
      const scripted = promotableExecution('')
      Object.assign(scripted.proc, {
        promotion: Promise.resolve(undefined),
        result: () => Promise.resolve({
          exitCode: 1,
          signal: null,
          timedOut: true,
          aborted: false,
          timeoutMs: 250,
          stdout: { text: '', truncated: false },
          stderr: { text: '', truncated: false },
        }),
      })
      return scripted.proc
    }
    const result = await call(ctx, { command: 'Get-Slow', description: 'test command', timeoutMs: 250 })
    expect((result.content[0] as { text: string }).text).toContain('[timed out after 250ms]')
    expect(specs[0]?.onExpiry).toBe('kill')
    const description = ctx.tools.get('pwsh')?.description ?? ''
    expect(description).not.toContain('moves to the background')
  })

  it('advertises the promotion semantics in the description and the timeout parameter', async () => {
    const { ctx } = await setup()
    const tool = ctx.tools.get('pwsh')
    expect(tool?.description).toContain('A foreground command that reaches its timeout is not killed')
    expect(JSON.stringify(tool?.parameters)).toContain('moves to the background as a job instead of being killed')
  })
})

describe('renderPwshPromoted', () => {
  it('pins the promoted text with and without pre-promotion output', () => {
    expect(renderPwshPromoted({ jobId: 'pwsh-7', timeoutMs: 120_000, output: '' })).toBe(
      '[still running after 120000ms; moved to background job pwsh-7]\n'
      + 'The command keeps running in the background. You will be notified when it finishes; '
      + 'read newer output with job_output, stop it with job_kill.',
    )
    expect(renderPwshPromoted({ jobId: 'pwsh-7', timeoutMs: 250, output: 'partial' }))
      .toContain('partial\n[still running after 250ms; moved to background job pwsh-7]')
    expect(renderPwshPromoted({ jobId: 'pwsh-7', timeoutMs: 250, output: 'line\n' }))
      .toContain('line\n[still running after 250ms')
  })
})

describe('owned and degraded observation (pwsh)', () => {
  it('mirrors an owned background run under the owning session', async () => {
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
    const row = await until(() => ctx.activities.list(owner).find(item => item.correlation?.jobId === job!.id))
    expect(row.ownerSession).toBe(owner.id)
    scripted.finish()
    await until(() => ctx.jobs.get(job!.id, owner).status === 'completed' ? true : undefined)
  })

  it('swallows a throwing observation registry and keeps the job alive', async () => {
    const { ctx, pwsh } = await setup()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    vi.spyOn(ctx.activities, 'open').mockImplementation(() => { throw new Error('registry down') })
    const scripted = observableProcess()
    pwsh.backgroundHandler = () => scripted.proc
    await call(ctx, { command: 'Get-Slow', description: 'test command', run_in_background: true })
    const job = ctx.jobs.list()[0]
    expect(job?.status).toBe('running')
    expect(warn.mock.calls.map(args => String(args[0])).join('\n'))
      .toContain('activity observation unavailable for this run')
    scripted.finish()
    await until(() => ctx.jobs.get(job!.id).status === 'completed' ? true : undefined)
  })
})
