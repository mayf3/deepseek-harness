import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
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
import type { JobId } from '@deepseek-ai/dsh-jobs'
import * as ToolTasks from '@deepseek-ai/dsh-tool-jobs'
import type { ShellProcess } from '@deepseek-ai/dsh-shell'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import { processSources } from '../src/background.ts'
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
    const reader = (channel: string, text: string): ShellProcess['observed']['stdout'] => ({
      readFrom: (from: number) => { reads.push({ channel, from }); return { text, nextOffset: from + text.length, lossy: false } },
    })
    const proc: Pick<ShellProcess, 'observed'> = { observed: { stdout: reader('stdout', 'out'), stderr: reader('stderr', 'err!') } }
    const [stdout, stderr] = processSources(() => proc)
    expect(stdout!.read(2)).toEqual({ text: 'out', nextOffset: 5, lossy: false })
    expect(stderr!.read(7)).toEqual({ text: 'err!', nextOffset: 11, lossy: false })
    expect(reads).toEqual([{ channel: 'stdout', from: 2 }, { channel: 'stderr', from: 7 }])
  })

  it("passes a lossy read's spill file through, so the model's notice can name it", () => {
    const proc: Pick<ShellProcess, 'observed'> = {
      observed: {
        stdout: { readFrom: (from: number) => ({ text: '', nextOffset: from, lossy: false }) },
        stderr: { readFrom: (from: number) => ({ text: 'tail', nextOffset: from + 4, lossy: true, spillPath: '/spill/err.log' }) },
      },
    }
    const [, stderr] = processSources(() => proc)
    expect(stderr!.read(0)).toEqual({ text: 'tail', nextOffset: 4, lossy: true, spillPath: '/spill/err.log' })
  })
})

describe('owned background output', () => {
  it('fences an owned background run under the owning session', async () => {
    const ctx = await setup()
    const ownerId = SessionId('background-owner')
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
