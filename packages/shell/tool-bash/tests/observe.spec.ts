import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import type { ActivitySnapshot } from '@deepseek-ai/dsh-activity'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import { renderPromoted } from '../src/render.ts'
import * as BashEnvPlugin from '@deepseek-ai/dsh-shell-env'

const testToolSignal = new AbortController().signal
const spillDir = mkdtempSync(join(tmpdir(), 'dsh-tool-bash-observe-spec-'))

/** Job harness plus the observation registry, with a fast pump for tests. */
async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry)
  await ctx.plugin(ToolTasks)
  await ctx.plugin(LocalActivityRegistry)
  await ctx.plugin(LocalSubprocessRuntime)
  ;(ctx.subprocess as LocalSubprocessRuntime).internals = { spillDir }
  await ctx.plugin(BashEnvPlugin)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000, graceMs: 200 })
  await ctx.plugin(ToolBash, { activityPollMs: 25 })
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

function retainedText(ctx: Context, id: ActivitySnapshot['id']): string {
  return ctx.activities.read(id, 0).chunks.map(chunk => chunk.text).join('')
}

describe('background bash observation', () => {
  it('mirrors a background run into ctx.activities with correlation, live output, and settlement', async () => {
    const ctx = await setup()
    const ack = await call(ctx, {
      command: 'printf "line-1\\n"; sleep 0.4; printf "line-2\\n"',
      description: 'test command',
      run_in_background: true,
    })
    expect(text(ack)).toContain('started background job')
    const job = ctx.jobs.list()[0]
    expect(job).toBeDefined()

    const snapshot = await until(() =>
      ctx.activities.list().find(row => row.correlation?.jobId === job!.id))
    expect(snapshot.kind).toBe('bash')
    expect(snapshot.label).toContain('printf')
    expect(String(snapshot.correlation?.callId)).toMatch(/^observe-call-/)

    // Live output appears while the command is still running.
    await until(() => retainedText(ctx, snapshot.id).includes('line-1') ? true : undefined)
    expect(ctx.activities.get(snapshot.id).status).toBe('running')

    // Settlement carries the mapped bash outcome and the trailing output.
    await until(() => ctx.activities.get(snapshot.id).status === 'completed' ? true : undefined)
    expect(ctx.activities.get(snapshot.id).detail).toBe('exit code: 0')
    expect(retainedText(ctx, snapshot.id)).toContain('line-2')

    // The model-facing consuming cursor still delivers everything: observation stole nothing.
    const collected = await until(() => {
      const read = ctx.jobs.read(job!.id)
      return read.text.includes('line-1') ? read.text : undefined
    })
    expect(collected).toContain('line-2')
  })

  it('a killed background job settles its mirrored process as killed', async () => {
    const ctx = await setup()
    await call(ctx, { command: 'sleep 60', description: 'test command', run_in_background: true })
    const job = ctx.jobs.list()[0]
    const snapshot = await until(() =>
      ctx.activities.list().find(row => row.correlation?.jobId === job!.id))
    ctx.jobs.kill(job!.id, undefined, { reason: 'test cleanup' })
    await until(() => ctx.activities.get(snapshot.id).status === 'killed' ? true : undefined)
    expect(ctx.activities.get(snapshot.id).detail).toMatch(/signal|killed before exit/)
  })

  it('labels stderr chunks with their channel', async () => {
    const ctx = await setup()
    await call(ctx, {
      command: 'echo out-line; echo err-line 1>&2',
      description: 'test command',
      run_in_background: true,
    })
    const job = ctx.jobs.list()[0]
    const snapshot = await until(() =>
      ctx.activities.list().find(row => row.correlation?.jobId === job!.id))
    await until(() => ctx.activities.get(snapshot.id).status === 'completed' ? true : undefined)
    const chunks = ctx.activities.read(snapshot.id, 0).chunks
    expect(chunks.find(chunk => chunk.text.includes('out-line'))?.channel).toBe('stdout')
    expect(chunks.find(chunk => chunk.text.includes('err-line'))?.channel).toBe('stderr')
  })

  it('a registry whose handle rejects appends degrades to a warning and still settles', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalJobRegistry)
    await ctx.plugin(ToolTasks)
    const ended: unknown[] = []
    await ctx.plugin({
      name: 'appending-broken-activities-probe',
      apply(child: Context) {
        child.provide('activities', {
          open: () => ({
            id: 'bash-1',
            append() { throw new Error('append boom') },
            updateDetail() {},
            end(outcome: unknown) { ended.push(outcome) },
          }),
        })
      },
    })
    await ctx.plugin(LocalSubprocessRuntime)
    ;(ctx.subprocess as LocalSubprocessRuntime).internals = { spillDir }
    await ctx.plugin(BashEnvPlugin)
    await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000, graceMs: 200 })
    const warn = vi.fn()
    ctx.logger.warn = warn as never
    await ctx.plugin(ToolBash, { activityPollMs: 25 })
    await call(ctx, { command: 'echo tolerated', description: 'test command', run_in_background: true })
    await until(() => ended.length > 0 ? true : undefined)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('activity observation pump'))
    expect(ended[0]).toMatchObject({ status: 'completed' })
  })

  it('a pump failure waits for process settlement before mapping the outcome', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalJobRegistry)
    await ctx.plugin(ToolTasks)
    const ended: unknown[] = []
    await ctx.plugin({
      name: 'early-failing-activities-probe',
      apply(child: Context) {
        child.provide('activities', {
          open: () => ({
            id: 'bash-1',
            append() { throw new Error('append boom') },
            updateDetail() {},
            end(outcome: unknown) { ended.push(outcome) },
          }),
        })
      },
    })
    await ctx.plugin(LocalSubprocessRuntime)
    ;(ctx.subprocess as LocalSubprocessRuntime).internals = { spillDir }
    await ctx.plugin(BashEnvPlugin)
    await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000, graceMs: 200 })
    const warn = vi.fn()
    ctx.logger.warn = warn as never
    await ctx.plugin(ToolBash, { activityPollMs: 25 })
    // One early line makes the first pump poll append (and fail) while the
    // process still has most of its sleep ahead.
    await call(ctx, { command: 'printf "early\\n"; sleep 0.7', description: 'test command', run_in_background: true })
    await until(() => warn.mock.calls.some(args => String(args[0]).includes('activity observation pump')) ? true : undefined)
    // The pump already failed; the outcome must wait for real settlement
    // rather than freezing a fake terminal state onto the running process.
    expect(ended).toHaveLength(0)
    await until(() => ended.length > 0 ? true : undefined)
    expect(ended[0]).toMatchObject({ status: 'completed', detail: 'exit code: 0' })
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
            id: 'bash-1',
            append() {},
            updateDetail() {},
            end() { throw new Error('end boom') },
          }),
        })
      },
    })
    await ctx.plugin(LocalSubprocessRuntime)
    ;(ctx.subprocess as LocalSubprocessRuntime).internals = { spillDir }
    await ctx.plugin(BashEnvPlugin)
    await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000, graceMs: 200 })
    const warn = vi.fn()
    ctx.logger.warn = warn as never
    await ctx.plugin(ToolBash, { activityPollMs: 25 })
    await call(ctx, { command: 'echo settled', description: 'test command', run_in_background: true })
    await until(() => warn.mock.calls.some(args => String(args[0]).includes('activity settlement mapping')) ? true : undefined)
  })

  it('a throwing observation registry never breaks the background call', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalJobRegistry)
    await ctx.plugin(ToolTasks)
    await ctx.plugin({
      name: 'broken-activities-probe',
      apply(child: Context) {
        child.provide('activities', { open() { throw new Error('observation boom') } })
      },
    })
    await ctx.plugin(LocalSubprocessRuntime)
    ;(ctx.subprocess as LocalSubprocessRuntime).internals = { spillDir }
    await ctx.plugin(BashEnvPlugin)
    await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000, graceMs: 200 })
    const warn = vi.fn()
    ctx.logger.warn = warn as never
    await ctx.plugin(ToolBash, { activityPollMs: 25 })
    const ack = await call(ctx, { command: 'echo resilient', description: 'test command', run_in_background: true })
    expect(text(ack)).toContain('started background job')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('activity observation unavailable'))
    // The job itself still completes and reads normally.
    const job = ctx.jobs.list()[0]
    const read = await until(() => {
      const value = ctx.jobs.read(job!.id)
      return value.text.includes('resilient') ? value : undefined
    })
    expect(read.snapshot.status).toBe('completed')
  })
})

describe('foreground timeout promotion', () => {
  it('moves a timed-out foreground command into a job with its output so far, mirrored as an activity', async () => {
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

    const job = ctx.jobs.list()[0]
    expect(job).toMatchObject({ id: 'bash-1', kind: 'bash', status: 'running', label: 'printf "early-output\\n"; sleep 30' })

    // The activity mirror carries the tool-call correlation like any background run.
    const snapshot = await until(() =>
      ctx.activities.list().find(row => row.correlation?.jobId === job!.id))
    expect(snapshot.kind).toBe('bash')

    // The job's consuming cursor continues after the promoted result's output:
    // no repeat of the early line, and the job stays killable.
    expect(ctx.jobs.read(job!.id).text).not.toContain('early-output')
    expect(ctx.jobs.kill(job!.id, undefined, { reason: 'test cleanup' })).toBe('requested')
    await until(() => ctx.jobs.get(job!.id).status === 'killed' ? true : undefined)
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
    await ctx.plugin(LocalJobRegistry)
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

describe('owned background observation', () => {
  it('mirrors an owned background run under the owning session', async () => {
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
      arguments: { command: 'sleep 0.3', description: 'test command', run_in_background: true },
      agent: owner,
    })
    const job = ctx.jobs.list(owner)[0]
    expect(job).toBeDefined()
    const row = await until(() => ctx.activities.list(owner).find(item => item.correlation?.jobId === job!.id))
    expect(row.ownerSession).toBe(owner.id)
    ctx.jobs.kill(job!.id, owner, { reason: 'test cleanup' })
    await until(() => ctx.jobs.get(job!.id, owner).status === 'killed' ? true : undefined)
  })
})
