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
import type { JobId, RunningJob } from '@deepseek-ai/dsh-jobs'
import * as ToolTasks from '@deepseek-ai/dsh-tool-jobs'
import type { ShellProcess } from '@deepseek-ai/dsh-shell'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import { observeProcessRecord } from '../src/observe.ts'
import * as BashEnvPlugin from '@deepseek-ai/dsh-shell-env'

const testToolSignal = new AbortController().signal
const spillDir = mkdtempSync(join(tmpdir(), 'dsh-tool-bash-observe-spec-'))

/** Job harness with a fast record pump for tests. */
async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry)
  await ctx.plugin(ToolTasks)
  await ctx.plugin(LocalSubprocessRuntime)
  ;(ctx.subprocess as LocalSubprocessRuntime).internals = { spillDir }
  await ctx.plugin(BashEnvPlugin)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000, graceMs: 200 })
  await ctx.plugin(ToolBash, { recordPollMs: 25 })
  return ctx
}

let callCounter = 0
function call(ctx: Context, args: Record<string, unknown>) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`observe-call-${++callCounter}`),
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
  return ctx.jobs.readRecord(id, 0, caller).chunks.map(chunk => chunk.text).join('')
}

describe('background bash record', () => {
  it('streams a background run into the job record with live output and settlement', async () => {
    const ctx = await setup()
    const ack = await call(ctx, {
      command: 'printf "line-1\\n"; sleep 0.4; printf "line-2\\n"',
      description: 'test command',
      run_in_background: true,
    })
    expect(text(ack)).toContain('started background job')
    const job = ctx.jobs.list()[0]
    expect(job).toBeDefined()
    expect(job!.outputTotal).toBeDefined()

    // Live output appears in the record while the command is still running.
    await until(() => retainedText(ctx, job!.id).includes('line-1') ? true : undefined)
    expect(ctx.jobs.get(job!.id).status).toBe('running')

    // Settlement ends the record with the job; the trailing bytes are drained first.
    await until(() => ctx.jobs.get(job!.id).status === 'completed' ? true : undefined)
    expect(ctx.jobs.get(job!.id).detail).toBe('exit code: 0')
    expect(retainedText(ctx, job!.id)).toContain('line-2')

    // The model-facing consuming cursor still delivers everything: observation stole nothing.
    const collected = await until(() => {
      const read = ctx.jobs.read(job!.id)
      return read.text.includes('line-1') ? read.text : undefined
    })
    expect(collected).toContain('line-2')
  })

  it('a killed background job ends its record with the killed settlement', async () => {
    const ctx = await setup()
    await call(ctx, { command: 'sleep 60', description: 'test command', run_in_background: true })
    const job = ctx.jobs.list()[0]
    ctx.jobs.kill(job!.id, undefined, 'test cleanup')
    await until(() => ctx.jobs.get(job!.id).status === 'killed' ? true : undefined)
    expect(ctx.jobs.get(job!.id).detail).toMatch(/signal|killed before exit/)
  })

  it('labels stderr chunks with their channel', async () => {
    const ctx = await setup()
    await call(ctx, {
      command: 'echo out-line; echo err-line 1>&2',
      description: 'test command',
      run_in_background: true,
    })
    const job = ctx.jobs.list()[0]
    await until(() => ctx.jobs.get(job!.id).status === 'completed' ? true : undefined)
    const chunks = ctx.jobs.readRecord(job!.id, 0).chunks
    expect(chunks.find(chunk => chunk.text.includes('out-line'))?.channel).toBe('stdout')
    expect(chunks.find(chunk => chunk.text.includes('err-line'))?.channel).toBe('stderr')
  })
})

describe('observeProcessRecord', () => {
  /** A RunningJob face recording appends for pump assertions. */
  function recordingJob(): { job: RunningJob; appends: string[] } {
    const appends: string[] = []
    return {
      job: {
        id: 'bash-1' as JobId,
        append(chunk) { appends.push(chunk) },
        updateDetail() {},
      },
      appends,
    }
  }

  it('degrades to no observation when the backend exposes no offset readers', async () => {
    const ctx = new Context()
    const { job, appends } = recordingJob()
    const proc = { done: Promise.resolve() } as unknown as ShellProcess
    await observeProcessRecord(ctx, job, proc, 25)
    expect(appends).toEqual([])
  })

  it('contains a pump failure with a warning; the job path is unaffected', async () => {
    const ctx = new Context()
    const warn = vi.fn()
    ctx.logger.warn = warn as never
    const { job } = recordingJob()
    const proc = {
      done: new Promise<void>((resolve) => { setTimeout(resolve, 10) }),
      observed: {
        stdout: { readFrom() { throw new Error('reader boom') } },
      },
    } as unknown as ShellProcess
    await observeProcessRecord(ctx, job, proc, 5)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('record observation pump for bash-1 failed'))
  })
})

describe('owned background record', () => {
  it('fences an owned background run record under the owning session', async () => {
    const ctx = await setup()
    const owner = {
      id: SessionId('observe-owner'),
      session: { id: SessionId('observe-owner'), header: { cwd: process.cwd() } },
      status: 'idle',
      ctx,
    } as unknown as Agent
    ctx.agents.register(owner)
    await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('observe-owned-1'),
      name: 'bash',
      arguments: { command: 'echo owned', description: 'test command', run_in_background: true },
      agent: owner,
    })
    const job = ctx.jobs.list(owner)[0]
    expect(job).toBeDefined()
    expect(job!.ownerSession).toBe(owner.id)
    await until(() => ctx.jobs.get(job!.id, owner).status === 'completed' ? true : undefined)
    expect(() => retainedText(ctx, job!.id)).toThrow(/belongs to another session/)
    await until(() => retainedText(ctx, job!.id, owner).includes('owned') ? true : undefined)
  })
})
