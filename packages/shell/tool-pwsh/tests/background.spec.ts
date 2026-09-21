import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session/types'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as ToolTasks from '@deepseek-ai/dsh-tool-jobs'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellExecution, ShellProcess } from '@deepseek-ai/dsh-shell'
import { renderPwshPromoted } from '../src/render.ts'
import * as ToolPwsh from '@deepseek-ai/dsh-tool-pwsh'
import * as BashEnvPlugin from '@deepseek-ai/dsh-shell-env'
import { processSources } from '../src/background.ts'

const testToolSignal = new AbortController().signal

/** ASCII-only scripted stream: readFrom offsets are byte-exact string indexes. */
function scriptedReader(state: { text: string }) {
  return {
    readFrom(fromByte: number) {
      return { text: state.text.slice(fromByte), nextOffset: state.text.length, lossy: false }
    },
  }
}

/** A running fake background handle over scripted non-consuming observed streams. */
function observableProcess(streams: { stdout: { text: string }; stderr: { text: string } } = { stdout: { text: '' }, stderr: { text: '' } }) {
  let resolveDone: () => void = () => {}
  const done = new Promise<void>((resolve) => { resolveDone = resolve })
  const proc: ShellProcess = {
    status: 'running',
    exitCode: null,
    signal: null,
    done,
    readOutput: () => ({ delta: '', lossy: false }),
    kill: () => false,
    observed: { stdout: scriptedReader(streams.stdout), stderr: scriptedReader(streams.stderr) },
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

  override async execute(spec: ShellExecSpec): Promise<ShellExecution> {
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
  await ctx.plugin(LocalJobRegistry, { pumpPollMs: 5 })
  await ctx.plugin(ToolTasks)
  await ctx.plugin(BashEnvPlugin)
  await ctx.plugin(FakePwsh)
  await ctx.plugin(ToolPwsh)
  return { ctx, pwsh: ctx.shell as FakePwsh }
}

let callCounter = 0
function call(ctx: Context, args: Record<string, unknown>) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`pwsh-background-${++callCounter}`),
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

describe('background pwsh output', () => {
  it('streams observed channels into the job ring and settles with the mapped outcome', async () => {
    const { ctx, pwsh } = await setup()
    const stdout = { text: '' }
    const stderr = { text: '' }
    const scripted = observableProcess({ stdout, stderr })
    pwsh.backgroundHandler = () => scripted.proc

    await call(ctx, { command: 'Get-Progress', description: 'test command', run_in_background: true })
    const jobs = ctx.jobs
    const job = jobs.list()[0]
    expect(job).toBeDefined()
    expect(job!.kind).toBe('pwsh')
    expect(job!.output).toEqual({ total: 0, earliest: 0 })

    stdout.text = 'progress-line\n'
    stderr.text = 'warn-line\n'
    await until(() => {
      const chunks = jobs.readAt(job!.id, 0).chunks
      return chunks.some(chunk => chunk.text.includes('progress-line'))
        && chunks.some(chunk => chunk.text.includes('warn-line'))
        ? true
        : undefined
    })
    const chunks = jobs.readAt(job!.id, 0).chunks
    expect(chunks.find(chunk => chunk.text.includes('progress-line'))?.channel).toBe('stdout')
    expect(chunks.find(chunk => chunk.text.includes('warn-line'))?.channel).toBe('stderr')

    scripted.finish()
    await until(() => jobs.get(job!.id).status === 'completed' ? true : undefined)
    expect(jobs.get(job!.id).detail).toBe('exit code: 0')
  })

  it('a failing reader warns once and never fakes a terminal state onto the running job', async () => {
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
    const jobs = ctx.jobs
    const job = jobs.list()[0]
    await until(() => warn.mock.calls.some(args => String(args[0]).includes('output source for')) ? true : undefined)
    // The reader already failed; the job must wait for real settlement rather
    // than freezing a fake terminal state onto the running process.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(jobs.get(job!.id).status).toBe('running')
    expect(warn).toHaveBeenCalledTimes(1)
    proc.status = 'completed'
    proc.exitCode = 0
    resolveDone()
    await until(() => jobs.get(job!.id).status !== 'running' ? true : undefined)
    expect(jobs.get(job!.id)).toMatchObject({ status: 'completed', detail: 'exit code: 0' })
  })

  it('a silent process settles with an empty ring', async () => {
    const { ctx, pwsh } = await setup()
    const scripted = observableProcess()
    pwsh.backgroundHandler = () => scripted.proc

    await call(ctx, { command: 'Start-Job', description: 'test command', run_in_background: true })
    const jobs = ctx.jobs
    const job = jobs.list()[0]
    expect(jobs.readAt(job!.id, 0).chunks).toEqual([])

    scripted.finish()
    await until(() => jobs.get(job!.id).status === 'completed' ? true : undefined)
    expect(jobs.get(job!.id).output).toEqual({ total: 0, earliest: 0 })
  })
})

describe('owned background output (pwsh)', () => {
  it('keeps an owned background run under the owning session', async () => {
    const { ctx, pwsh } = await setup()
    const ownerId = SessionId('pwsh-background-owner')
    const owner: Agent = {
      id: ownerId,
      options: {},
      session: Session.create(ownerId, undefined, {
        version: SESSION_FORMAT_VERSION, id: ownerId, createdAt: 0, cwd: process.cwd(), isSeeded: false,
      }),
      inbox: unsupportedInbox(),
      status: 'idle',
      ctx,
      send: () => {},
      followup: () => {},
      steer: () => {},
      inject: () => {},
      cancel: () => {},
      runMaintenance: task => task(new AbortController().signal),
      whenIdle: () => Promise.resolve(),
    }
    ctx.agents.register(owner)
    const scripted = observableProcess()
    pwsh.backgroundHandler = () => scripted.proc
    await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('pwsh-background-owned'),
      name: 'pwsh',
      arguments: { command: 'Get-Slow', description: 'test command', run_in_background: true },
      agent: owner,
    })
    const owned = ctx.jobs
    const job = owned.list(owner.id)[0]
    expect(job).toBeDefined()
    expect(job!.owner).toBe(owner.id)
    expect(() => ctx.jobs.readAt(job!.id, 0)).toThrow(/belongs to another session/)
    expect(owned.readAt(job!.id, 0, owner.id).chunks).toEqual([])
    scripted.finish()
    await until(() => owned.get(job!.id, owner.id).status === 'completed' ? true : undefined)
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
    const proc: ShellExecution = {
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
      observed: { stdout: scriptedReader({ text: '' }), stderr: scriptedReader({ text: '' }) },
      kill: () => false,
      promotion: Promise.resolve(offer),
      result: () => Promise.reject(new Error('result projection unused after promotion')),
    }
    return { proc, offer, finish: () => { settle() } }
  }

  it('moves a timed-out command into a pwsh record job carrying the output so far', async () => {
    const { ctx, pwsh } = await setup()
    const scripted = promotableExecution('early-output\n')
    pwsh.foregroundHandler = () => scripted.proc

    const result = await call(ctx, { command: 'Get-Slow', description: 'test command', timeoutMs: 250 })
    const body = (result.content[0] as { text: string }).text
    expect(body).toContain('early-output')
    expect(body).toContain('moved to background job pwsh-1]')
    expect(body).toContain('read newer output with job_output, stop it with job_kill')
    expect(scripted.offer.accepted).toBe(true)

    const jobs = ctx.jobs
    const job = jobs.list()[0]
    expect(job).toMatchObject({ id: 'pwsh-1', kind: 'pwsh', status: 'running' })
    // The ring starts where the promoted result stopped: the next read repeats nothing.
    expect(jobs.read(job!.id).chunks).toEqual([])
    scripted.finish()
    await until(() => jobs.get(job!.id).status === 'completed' ? true : undefined)
  })

  it('promotes under the calling agent and stops the promoted job through the registry kill', async () => {
    const { ctx, pwsh } = await setup()
    const ownerId = SessionId('pwsh-promote-owner')
    const owner: Agent = {
      id: ownerId,
      options: {},
      session: Session.create(ownerId, undefined, {
        version: SESSION_FORMAT_VERSION, id: ownerId, createdAt: 0, cwd: process.cwd(), isSeeded: false,
      }),
      inbox: unsupportedInbox(),
      status: 'idle',
      ctx,
      send: () => {},
      followup: () => {},
      steer: () => {},
      inject: () => {},
      cancel: () => {},
      runMaintenance: task => task(new AbortController().signal),
      whenIdle: () => Promise.resolve(),
    }
    ctx.agents.register(owner)
    let killed = false
    let resolveDone: () => void = () => {}
    const proc: ShellExecution = {
      status: 'running',
      exitCode: null,
      signal: null,
      done: new Promise<void>((resolve) => { resolveDone = resolve }),
      readOutput: () => ({ delta: '', lossy: false }),
      observed: { stdout: scriptedReader({ text: '' }), stderr: scriptedReader({ text: '' }) },
      kill: () => {
        killed = true
        proc.status = 'killed'
        proc.signal = 'SIGTERM'
        resolveDone()
        return true
      },
      promotion: Promise.resolve({ accepted: false, accept() { this.accepted = true }, decline() {} }),
      result: () => Promise.reject(new Error('result projection unused after promotion')),
    }
    pwsh.foregroundHandler = () => proc

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('pwsh-observe-promote-owned'),
      name: 'pwsh',
      arguments: { command: 'Get-Slow', description: 'test command', timeoutMs: 250 },
      agent: owner,
    })
    expect((result.content[0] as { text: string }).text).toContain('moved to background job')
    const owned = ctx.jobs
    const job = owned.list(owner.id)[0]
    expect(job).toBeDefined()
    expect(job!.owner).toBe(owner.id)

    expect(owned.kill(job!.id, owner.id, 'test cleanup')).toBe('requested')
    await until(() => killed ? true : undefined)
    const settled = await until(() => {
      const view = owned.get(job!.id, owner.id)
      return view.status === 'killed' ? view : undefined
    })
    expect(settled.detail).toBe('signal: SIGTERM; test cleanup')
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
    await ctx.plugin(ToolPwsh)
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

describe('processSources (pwsh)', () => {
  it('reads nothing while the process is not spawned yet', () => {
    const [stdout, stderr] = processSources(() => undefined)
    expect(stdout!.channel).toBe('stdout')
    expect(stderr!.channel).toBe('stderr')
    expect(stdout!.read(0)).toEqual({ text: '', nextOffset: 0, lossy: false })
    expect(stderr!.read(3)).toEqual({ text: '', nextOffset: 3, lossy: false })
  })
})
