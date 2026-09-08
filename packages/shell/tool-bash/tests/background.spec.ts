import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import * as ToolTasks from '@deepseek-ai/dsh-tool-jobs'
import type { ShellProcess } from '@deepseek-ai/dsh-shell'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import { observedOffsets, processSources } from '../src/background.ts'
import { renderPromoted } from '../src/render.ts'
import * as BashEnvPlugin from '@deepseek-ai/dsh-shell-env'

const testToolSignal = new AbortController().signal
const spillDir = mkdtempSync(join(tmpdir(), 'dsh-tool-bash-background-spec-'))

/** Job harness with a fast registry pump for tests. */
async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry, { pumpPollMs: 25 })
  await ctx.plugin(ToolTasks)
  await ctx.plugin(LocalSubprocessRuntime)
  ;(ctx.subprocess as LocalSubprocessRuntime).internals = { spillDir }
  await ctx.plugin(BashEnvPlugin)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000, graceMs: 200 })
  await ctx.plugin(ToolBash)
  return ctx
}

let callCounter = 0
function call(ctx: Context, args: Record<string, unknown>) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`background-call-${++callCounter}`),
    name: 'bash',
    arguments: args,
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

async function until<T>(read: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = read()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('condition not reached before timeout')
}

function retainedText(ctx: Context, id: JobId, caller?: Agent): string {
  return ctx.jobs.readAt(id, 0, caller?.id).chunks.map(chunk => chunk.text).join('')
}

describe('background bash output', () => {
  it('streams a background run into the job ring with live output and settlement', async () => {
    const ctx = await setup()
    const ack = await call(ctx, {
      command: 'printf "line-1\\n"; sleep 0.4; printf "line-2\\n"',
      description: 'test command',
      run_in_background: true,
    })
    expect(text(ack)).toContain('started background job')
    const jobs = ctx.jobs
    const job = jobs.list()[0]
    expect(job).toBeDefined()

    // Live output appears in the ring while the command is still running.
    await until(() => retainedText(ctx, job!.id).includes('line-1') ? true : undefined)
    expect(jobs.get(job!.id).status).toBe('running')

    // Settlement ends the ring with the job; the trailing bytes are drained first.
    await until(() => jobs.get(job!.id).status === 'completed' ? true : undefined)
    expect(jobs.get(job!.id).detail).toBe('exit code: 0')
    expect(retainedText(ctx, job!.id)).toContain('line-2')

    // The model-facing consuming cursor reads the same bytes: observation stole nothing.
    const consumed = jobs.read(job!.id).chunks.map(chunk => chunk.text).join('')
    expect(consumed).toContain('line-1')
    expect(consumed).toContain('line-2')
  })

  it('a killed background job settles killed with the kill reason merged into its detail', async () => {
    const ctx = await setup()
    await call(ctx, { command: 'sleep 60', description: 'test command', run_in_background: true })
    const jobs = ctx.jobs
    const job = jobs.list()[0]
    jobs.kill(job!.id, undefined, 'test cleanup')
    await until(() => jobs.get(job!.id).status === 'killed' ? true : undefined)
    expect(jobs.get(job!.id).detail).toMatch(/(signal|killed before exit).*; test cleanup$/)
  })

  it('a background spawn failure reaches the model as the stderr note master rendered', async () => {
    const ctx = await setup()
    const started = await call(ctx, {
      command: 'true',
      description: 'test command',
      workdir: '/nonexistent-dsh',
      run_in_background: true,
    })
    expect(text(started)).toMatch(/^started background job bash-\d+$/)
    const jobs = ctx.jobs
    const job = jobs.list()[0]
    await until(() => jobs.get(job!.id).status === 'killed' ? true : undefined)
    const read = text(await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('background-spawn-failure-read'),
      name: 'job_output',
      arguments: { job_id: String(job!.id) },
    }))
    expect(read).toMatch(/^\[stderr\]\nsubprocess failed before reporting an outcome: .*\n\[status: killed, killed before exit\]$/s)
  })

  it('labels stderr chunks with their channel', async () => {
    const ctx = await setup()
    await call(ctx, {
      command: 'echo out-line; echo err-line 1>&2',
      description: 'test command',
      run_in_background: true,
    })
    const jobs = ctx.jobs
    const job = jobs.list()[0]
    await until(() => jobs.get(job!.id).status === 'completed' ? true : undefined)
    const chunks = jobs.readAt(job!.id, 0).chunks
    expect(chunks.find(chunk => chunk.text.includes('out-line'))?.channel).toBe('stdout')
    expect(chunks.find(chunk => chunk.text.includes('err-line'))?.channel).toBe('stderr')
  })
})

describe('processSources', () => {
  it('reads nothing while the process is not spawned yet', () => {
    const [stdout, stderr] = processSources(() => undefined)
    expect(stdout!.channel).toBe('stdout')
    expect(stderr!.channel).toBe('stderr')
    expect(stdout!.read(0)).toEqual({ text: '', nextOffset: 0, lossy: false })
    expect(stderr!.read(3)).toEqual({ text: '', nextOffset: 3, lossy: false })
  })

  it('forwards each read to the matching stream reader at its own offset once the process exists', () => {
    const reads: { channel: string; from: number }[] = []
    const reader = (channel: string, text: string) => ({
      readFrom: (from: number) => { reads.push({ channel, from }); return { text, nextOffset: from + text.length, lossy: false } },
    })
    const proc = { observed: { stdout: reader('stdout', 'out'), stderr: reader('stderr', 'err!') } } as unknown as ShellProcess
    const [stdout, stderr] = processSources(() => proc)
    expect(stdout!.read(2)).toEqual({ text: 'out', nextOffset: 5, lossy: false })
    expect(stderr!.read(7)).toEqual({ text: 'err!', nextOffset: 11, lossy: false })
    expect(reads).toEqual([{ channel: 'stdout', from: 2 }, { channel: 'stderr', from: 7 }])
  })

  it("passes a lossy read's spill file through, so the model's notice can name it", () => {
    const proc = {
      observed: {
        stderr: { readFrom: (from: number) => ({ text: 'tail', nextOffset: from + 4, lossy: true, spillPath: '/spill/err.log' }) },
      },
    } as unknown as ShellProcess
    const [, stderr] = processSources(() => proc)
    expect(stderr!.read(0)).toEqual({ text: 'tail', nextOffset: 4, lossy: true, spillPath: '/spill/err.log' })
  })

  it('starts a promoted process\'s sources at the offsets already handed to the model', () => {
    const reads: number[] = []
    const proc = {
      observed: {
        stdout: { readFrom: (from: number) => { reads.push(from); return { text: '', nextOffset: Math.max(from, 40), lossy: false } } },
        stderr: { readFrom: (from: number) => ({ text: '', nextOffset: from, lossy: false }) },
      },
    } as unknown as ShellProcess
    const from = observedOffsets(proc)
    expect(from).toEqual({ stdout: 40, stderr: 0 })
    const [stdout, stderr] = processSources(() => proc, from)
    // The pump's first read (offset 0) lands at the stream's end, never before it.
    expect(stdout!.read(0)).toEqual({ text: '', nextOffset: 40, lossy: false })
    expect(reads).toEqual([0, 40])
    expect(stderr!.read(0)).toEqual({ text: '', nextOffset: 0, lossy: false })
  })
})

describe('foreground timeout promotion', () => {
  it('moves a timed-out foreground command into a job whose ring starts after the output so far', async () => {
    const ctx = await setup()
    const result = await call(ctx, {
      command: 'printf "early-output\\n"; sleep 30',
      description: 'test command',
      timeoutMs: 250,
    })
    const body = text(result)
    // The promoted result carries the pre-promotion output, the marker, and
    // the job hand-off guidance, in that order.
    expect(body).toContain('early-output')
    expect(body).toContain('[still running after 250ms; moved to background job bash-1]')
    expect(body).toContain('read newer output with job_output, stop it with job_kill')
    expect(body.indexOf('early-output')).toBeLessThan(body.indexOf('[still running'))

    const jobs = ctx.jobs
    const job = jobs.list()[0]
    expect(job).toMatchObject({ id: 'bash-1', kind: 'bash', status: 'running', label: 'printf "early-output\\n"; sleep 30' })

    // The ring starts where the promoted result stopped: the model's next
    // read repeats nothing, and observers never see the promoted line twice.
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(retainedText(ctx, job!.id)).not.toContain('early-output')
    expect(jobs.read(job!.id).chunks).toEqual([])
    expect(jobs.kill(job!.id, undefined, 'test cleanup')).toBe('requested')
    await until(() => jobs.get(job!.id).status === 'killed' ? true : undefined)
  })

  it('promotes under the calling agent so the job is fenced to its session', async () => {
    const ctx = await setup()
    const owner = {
      id: SessionId('promote-owner'),
      session: { id: SessionId('promote-owner'), header: { cwd: process.cwd() } },
      status: 'idle',
      ctx,
    } as unknown as Agent
    ctx.agents.register(owner)
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('background-promote-owned'),
      name: 'bash',
      arguments: { command: 'printf "held\\n"; sleep 30', description: 'test command', timeoutMs: 250 },
      agent: owner,
    })
    expect(text(result)).toContain('moved to background job')
    const owned = ctx.jobs
    const job = owned.list(owner.id)[0]
    expect(job).toBeDefined()
    expect(job!.owner).toBe(owner.id)
    expect(() => ctx.jobs.readAt(job!.id, 0)).toThrow(/belongs to another session/)
    expect(owned.kill(job!.id, owner.id, 'test cleanup')).toBe('requested')
    await until(() => owned.get(job!.id, owner.id).status === 'killed' ? true : undefined)
  })

  it('falls back to the timeout kill when the job admission refuses the promotion', async () => {
    const ctx = await setup()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    // Saturate the per-owner admission budget with unowned running jobs.
    const limit = 10
    const settlers: Array<(outcome: { status: 'killed' }) => void> = []
    for (let i = 0; i < limit; i++) {
      ctx.jobs.start({
        kind: 'bash',
        label: `filler-${i}`,
        run: () => {
          let settle!: (outcome: { status: 'killed' }) => void
          const done = new Promise<{ status: 'killed' }>((resolve) => { settle = resolve })
          settlers.push(settle)
          return { cancel: () => { settle({ status: 'killed' }) }, done }
        },
      })
    }
    const result = await call(ctx, {
      command: 'sleep 30',
      description: 'test command',
      timeoutMs: 250,
    })
    const body = text(result)
    expect(body).toContain('[timed out after 250ms]')
    expect(body).not.toContain('moved to background job')
    expect(warn.mock.calls.map(args => String(args[0])).join('\n')).toContain('timeout promotion unavailable')
    for (const settle of settlers) settle({ status: 'killed' })
  })

  it('keeps the plain timeout kill when promotion is configured off', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalJobRegistry, { pumpPollMs: 25 })
    await ctx.plugin(ToolTasks)
    await ctx.plugin(LocalSubprocessRuntime)
    ;(ctx.subprocess as LocalSubprocessRuntime).internals = { spillDir }
    await ctx.plugin(BashEnvPlugin)
    await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000, graceMs: 200 })
    await ctx.plugin(ToolBash, { promoteOnTimeout: false })
    const result = await call(ctx, { command: 'sleep 30', description: 'test command', timeoutMs: 250 })
    expect(text(result)).toContain('[timed out after 250ms]')
    expect(ctx.jobs.list()).toEqual([])
    const description = ctx.tools.get('bash')?.description ?? ''
    expect(description).not.toContain('moves to the background')
  })

  it('advertises the promotion semantics in the description and the timeout parameter', async () => {
    const ctx = await setup()
    const tool = ctx.tools.get('bash')
    expect(tool?.description).toContain('A foreground command that reaches its timeout is not killed')
    expect(JSON.stringify(tool?.parameters)).toContain('moves to the background as a job instead of being killed')
  })
})

describe('renderPromoted', () => {
  it('pins the promoted text with and without pre-promotion output', () => {
    expect(renderPromoted({ jobId: 'bash-7', timeoutMs: 120_000, output: '' })).toBe(
      '[still running after 120000ms; moved to background job bash-7]\n'
      + 'The command keeps running in the background. You will be notified when it finishes; '
      + 'read newer output with job_output, stop it with job_kill.',
    )
    // A partial line gains the separating newline exactly once.
    expect(renderPromoted({ jobId: 'bash-7', timeoutMs: 250, output: 'partial' }))
      .toContain('partial\n[still running after 250ms; moved to background job bash-7]')
    expect(renderPromoted({ jobId: 'bash-7', timeoutMs: 250, output: 'line\n' }))
      .toContain('line\n[still running after 250ms')
  })
})

describe('owned background output', () => {
  it('fences an owned background run under the owning session', async () => {
    const ctx = await setup()
    const owner = {
      id: SessionId('background-owner'),
      session: { id: SessionId('background-owner'), header: { cwd: process.cwd() } },
      status: 'idle',
      ctx,
    } as unknown as Agent
    ctx.agents.register(owner)
    await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('background-owned-1'),
      name: 'bash',
      arguments: { command: 'echo owned', description: 'test command', run_in_background: true },
      agent: owner,
    })
    const owned = ctx.jobs
    const job = owned.list(owner.id)[0]
    expect(job).toBeDefined()
    expect(job!.owner).toBe(owner.id)
    await until(() => owned.get(job!.id, owner.id).status === 'completed' ? true : undefined)
    expect(() => retainedText(ctx, job!.id)).toThrow(/belongs to another session/)
    await until(() => retainedText(ctx, job!.id, owner).includes('owned') ? true : undefined)
  })
})
