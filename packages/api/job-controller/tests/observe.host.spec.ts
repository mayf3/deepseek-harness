import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { JobId } from '@deepseek-ai/dsh-jobs'
import type { JobOutcome, RecordingJob } from '@deepseek-ai/dsh-jobs'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { JobController } from '../src/index.ts'
import { observeJobRecord } from '../src/observe.ts'
import type { ObserveJobOptions } from '../src/observe.ts'
import type { JobObserveFrame } from '../src/types.ts'

async function harness() {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry, { retainBytes: 64, settledRetainBytes: 64 })
  ctx.jobs.attachController('observe-job-test')
  return ctx
}

function registerAgent(ctx: Context, rawId: string): Agent {
  const scopeFiber = ctx.plugin(() => {})
  const id = SessionId(rawId)
  const session = Session.create(id)
  const agent = {
    id,
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: scopeFiber.ctx,
  } as unknown as Agent
  ctx.agents.register(agent)
  return agent
}

/** Start one record job whose done settles on demand; expose the producer face. */
function startRecordJob(ctx: Context, options: { label?: string; owner?: Agent; record?: boolean } = {}) {
  let settle!: (outcome: JobOutcome) => void
  let face!: RecordingJob
  const id = ctx.jobs.start({
    kind: 'bash',
    label: options.label ?? 'echo',
    ...options.owner !== undefined ? { owner: options.owner } : {},
    ...options.record === false ? {} : { record: true },
    run: (job: RecordingJob) => {
      face = job
      return {
        cancel() {},
        done: new Promise<JobOutcome>((resolve) => { settle = resolve }),
      }
    },
  })
  return {
    id,
    append: (text: string, opts?: Parameters<RecordingJob['append']>[1]) => { face.append(text, opts) },
    updateDetail: (detail: string) => { face.updateDetail(detail) },
    settle: async (outcome: JobOutcome) => {
      settle(outcome)
      await new Promise(resolve => setTimeout(resolve, 0))
    },
  }
}

/** Read frames until `count` arrive or the generator finishes, then abort. */
async function collect<Frame>(
  iterable: AsyncIterable<Frame>,
  count: number,
  abort: AbortController,
): Promise<Frame[]> {
  const frames: Frame[] = []
  const iterator = iterable[Symbol.asyncIterator]()
  try {
    while (frames.length < count) {
      const step = await iterator.next()
      if (step.done) return frames
      frames.push(step.value)
    }
  } finally {
    abort.abort()
    await iterator.next().catch(() => undefined)
  }
  return frames
}

const OBSERVE: Omit<ObserveJobOptions, 'caller'> = { flushMs: 5, maxFrameBytes: 1024 }

describe('observeJobRecord', () => {
  function observed(ctx: Context, request: { jobId: JobId; from?: number }, caller?: Agent) {
    const abort = new AbortController()
    const frames: JobObserveFrame[] = []
    const stream = observeJobRecord(ctx.jobs, request, { ...OBSERVE, caller }, abort.signal)
    const done = (async () => {
      for await (const frame of stream) frames.push(frame)
    })()
    return { abort, frames, done }
  }

  it('anchors, streams coalesced output, and closes with the terminal status', async () => {
    const ctx = await harness()
    const job = startRecordJob(ctx)
    job.append('early ')
    const { frames, done } = observed(ctx, { jobId: job.id })
    await new Promise(resolve => setTimeout(resolve, 20))
    job.append('live', { channel: 'stderr' })
    await new Promise(resolve => setTimeout(resolve, 20))
    await job.settle({ status: 'completed', detail: 'exit code: 0' })
    await done

    expect(frames[0]).toMatchObject({ type: 'opened', from: 0, earliest: 0, total: 6, status: 'running' })
    const outputs = frames.filter(frame => frame.type === 'output')
    const text = outputs.flatMap(frame => frame.chunks.map(chunk => chunk.text)).join('')
    expect(text).toBe('early live')
    expect(outputs.at(-1)?.next).toBe(10)
    expect(outputs.flatMap(frame => frame.chunks).find(chunk => chunk.text === 'live')?.channel).toBe('stderr')
    expect(frames.at(-1)).toMatchObject({ type: 'status', status: 'completed', detail: 'exit code: 0' })
  })

  it('resumes from an explicit offset and flags an evicted resume lossy', async () => {
    const ctx = await harness()
    const job = startRecordJob(ctx, { label: 'spam' })
    job.append('a'.repeat(60))
    job.append('b'.repeat(60))
    await job.settle({ status: 'completed' })

    const fresh = observed(ctx, { jobId: job.id, from: 0 })
    await fresh.done
    const output = fresh.frames.find(frame => frame.type === 'output')
    expect(output?.lossy).toBe(true)
    expect(output?.chunks.map(chunk => chunk.text).join('')).toBe('b'.repeat(60))

    const resumed = observed(ctx, { jobId: job.id, from: 120 })
    await resumed.done
    expect(resumed.frames.some(frame => frame.type === 'output')).toBe(false)
    expect(resumed.frames.at(-1)?.type).toBe('status')
  })

  it('splits oversized reads along the frame budget', async () => {
    const ctx = await harness()
    const job = startRecordJob(ctx, { label: 'wide' })
    job.append('x'.repeat(30))
    job.append('y'.repeat(30))
    await job.settle({ status: 'completed' })
    const abort = new AbortController()
    const frames = await collect<JobObserveFrame>(
      observeJobRecord(ctx.jobs, { jobId: job.id }, {
        flushMs: 5,
        maxFrameBytes: 30,
        caller: undefined,
      }, abort.signal),
      5,
      abort,
    )
    const outputs = frames.filter(frame => frame.type === 'output')
    expect(outputs).toHaveLength(2)
    expect(outputs[0]?.next).toBe(30)
    expect(outputs[1]?.next).toBe(60)
  })

  it('carries the lossy flag on the first frame of a split evicted read', async () => {
    const ctx = await harness()
    const job = startRecordJob(ctx, { label: 'evicted split' })
    job.append('a'.repeat(40))
    job.append('b'.repeat(40))
    job.append('c'.repeat(40))
    await job.settle({ status: 'completed' })
    const abort = new AbortController()
    const frames = await collect<JobObserveFrame>(
      observeJobRecord(ctx.jobs, { jobId: job.id, from: 0 }, {
        flushMs: 5,
        maxFrameBytes: 40,
        caller: undefined,
      }, abort.signal),
      5,
      abort,
    )
    const outputs = frames.filter(frame => frame.type === 'output')
    expect(outputs[0]?.lossy).toBe(true)
    expect(outputs[1]?.lossy).toBeUndefined()
  })

  it('reads owned records through the resolved caller and rejects foreign, bad, and unknown input', async () => {
    const ctx = await harness()
    const owner = registerAgent(ctx, 'alice')
    const job = startRecordJob(ctx, { label: 'secret', owner })
    job.append('classified')
    await job.settle({ status: 'completed' })

    const { frames, done } = observed(ctx, { jobId: job.id }, owner)
    await done
    expect(frames.some(frame => frame.type === 'output'
      && frame.chunks.some(chunk => chunk.text === 'classified'))).toBe(true)

    const foreign = new AbortController()
    await expect(collect(
      observeJobRecord(ctx.jobs, { jobId: job.id }, { ...OBSERVE, caller: undefined }, foreign.signal),
      1,
      foreign,
    )).rejects.toThrow(/belongs to another session/)

    const abort = new AbortController()
    await expect(collect(
      observeJobRecord(ctx.jobs, { jobId: job.id, from: -1 }, { ...OBSERVE, caller: owner }, abort.signal),
      1,
      abort,
    )).rejects.toThrow(/invalid observe offset/)

    const abortUnknown = new AbortController()
    await expect(collect(
      observeJobRecord(ctx.jobs, { jobId: JobId('bash-999') }, { ...OBSERVE, caller: undefined }, abortUnknown.signal),
      1,
      abortUnknown,
    )).rejects.toThrow(/unknown job/)
  })

  it('refuses a job that declared no record', async () => {
    const ctx = await harness()
    const job = startRecordJob(ctx, { record: false })
    const abort = new AbortController()
    await expect(collect(
      observeJobRecord(ctx.jobs, { jobId: job.id }, { ...OBSERVE, caller: undefined }, abort.signal),
      1,
      abort,
    )).rejects.toThrow(/declared no output record/)
    await job.settle({ status: 'completed' })
  })

  it('anchors with the live detail and takes the fast wait path for a wake that lands mid-yield', async () => {
    const ctx = await harness()
    const job = startRecordJob(ctx)
    job.updateDetail('3/10')
    const abort = new AbortController()
    const iterator = observeJobRecord(ctx.jobs, { jobId: job.id }, { ...OBSERVE, caller: undefined }, abort.signal)[Symbol.asyncIterator]()

    const anchor = await iterator.next()
    expect(anchor.value).toMatchObject({ type: 'opened', detail: '3/10' })
    // Both chunks land while the generator is suspended on a yield, so each
    // wake precedes the loop's wait(): draining the first chunk must pass
    // through the already-woken fast path to read the second.
    job.append('woken')
    const first = await iterator.next()
    expect(first.value).toMatchObject({ type: 'output' })
    job.append('again')
    const second = await iterator.next()
    expect(second.value).toMatchObject({ type: 'output' })
    const pending = iterator.next()
    await job.settle({ status: 'completed' })
    const status = await pending
    expect(status.value).toMatchObject({ type: 'status', status: 'completed' })
    expect((await iterator.next()).done).toBe(true)
  })

  it('ignores output signals for other jobs while waiting', async () => {
    const ctx = await harness()
    const watched = startRecordJob(ctx, { label: 'watched' })
    const noisy = startRecordJob(ctx, { label: 'noisy' })
    const { abort, frames, done } = observed(ctx, { jobId: watched.id })
    await new Promise(resolve => setTimeout(resolve, 15))
    noisy.append('unrelated')
    await new Promise(resolve => setTimeout(resolve, 15))
    await watched.settle({ status: 'completed' })
    await done
    abort.abort()
    expect(frames.filter(frame => frame.type === 'output')).toEqual([])
    await noisy.settle({ status: 'completed' })
  })

  it('stops cleanly on abort while waiting for output', async () => {
    const ctx = await harness()
    const job = startRecordJob(ctx, { label: 'idle' })
    const { abort, frames, done } = observed(ctx, { jobId: job.id })
    await new Promise(resolve => setTimeout(resolve, 20))
    abort.abort()
    await done
    expect(frames[0]?.type).toBe('opened')
    expect(frames.at(-1)?.type).not.toBe('status')
    await job.settle({ status: 'completed' })
  })
})

describe('JobController.observe', () => {
  async function controllerHarness() {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalJobRegistry)
    await ctx.plugin(TypertRegistry)
    ctx.jobs.attachController('observe-job-test')
    await ctx.plugin(JobController, {})
    return ctx
  }

  it('waits for the job registry instead of serving without one', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(TypertRegistry)
    ctx.plugin(JobController, {})
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(ctx.get('jobController')).toBeUndefined()
  })

  it('resolves the fenced-read caller from the request session', async () => {
    const ctx = await controllerHarness()
    const session = ctx.sessions.create(SessionId('observing-session'))
    const owner = {
      id: session.id,
      session,
      inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
      status: 'idle',
      ctx,
    } as unknown as Agent
    ctx.agents.register(owner)
    const job = startRecordJob(ctx, { label: 'owned run', owner })
    job.append('hi')
    await job.settle({ status: 'completed' })

    const abort = new AbortController()
    const frames = await collect<JobObserveFrame>(
      ctx.jobController.observe({ sessionId: session.id, jobId: job.id }, abort.signal),
      3,
      abort,
    )
    expect(frames.map(frame => frame.type)).toEqual(['opened', 'output', 'status'])
  })

  it('observes an unowned job without a request session', async () => {
    const ctx = await controllerHarness()
    const job = startRecordJob(ctx, { label: 'unowned run' })
    job.append('open access')
    await job.settle({ status: 'completed' })

    const abort = new AbortController()
    const frames = await collect<JobObserveFrame>(
      ctx.jobController.observe({ jobId: job.id }, abort.signal),
      3,
      abort,
    )
    expect(frames.map(frame => frame.type)).toEqual(['opened', 'output', 'status'])
  })
})
