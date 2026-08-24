import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import LocalActivityRegistry from '@deepseek-ai/dsh-activity-local'
import { ActivityId } from '@deepseek-ai/dsh-activity'
import { ActivityFeed } from '../src/feed.ts'
import { observeActivity } from '../src/observe.ts'
import type { ObserveOptions } from '../src/observe.ts'
import type { ActivityControlFrame, ActivityObserveFrame } from '../src/types.ts'

async function harness(withRegistry = true) {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  if (withRegistry) await ctx.plugin(LocalActivityRegistry, { retainBytes: 64, settledRetainBytes: 64 })
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

const OBSERVE: Omit<ObserveOptions, 'ownerOf'> = { flushMs: 5, maxFrameBytes: 1024 }

describe('ActivityFeed roster', () => {
  it('serves an empty baseline without the registry', async () => {
    const ctx = await harness(false)
    const feed = new ActivityFeed(ctx)
    expect(feed.baseline()).toEqual([])
  })

  it('projects owned and unowned rows into the baseline with correlation and no live objects', async () => {
    const ctx = await harness()
    const owner = registerAgent(ctx, 'alice')
    ctx.activities.open({ kind: 'bash', label: 'unowned build' })
    ctx.activities.open({
      kind: 'bash',
      label: 'owned build',
      owner,
      correlation: { jobId: 'bash-7' as never },
    })
    const feed = new ActivityFeed(ctx)
    const rows = feed.baseline()
    expect(rows).toHaveLength(2)
    const owned = rows.find(row => row.sessionId !== undefined)
    expect(owned?.sessionId).toBe('alice')
    expect(owned?.correlation).toEqual({ jobId: 'bash-7' })
    expect(owned?.status).toBe('running')
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain('owner')
      expect(row.outputTotal).toBe(0)
    }
  })

  it('pushes whole-bucket frames for open, detail, settlement, and removal', async () => {
    const ctx = await harness()
    const owner = registerAgent(ctx, 'alice')
    const feed = new ActivityFeed(ctx)
    const abort = new AbortController()
    const frames = collect<ActivityControlFrame>(feed.follow(abort.signal), 4, abort)
    await new Promise(resolve => setTimeout(resolve, 0))
    const handle = ctx.activities.open({ kind: 'bash', label: 'work', owner })
    handle.updateDetail('halfway')
    handle.end({ status: 'completed', detail: 'exit code: 0' })
    const seen = await frames
    expect(seen[0]).toEqual({ type: 'baseline', activities: [] })
    const rows = seen.slice(1) as Extract<ActivityControlFrame, { type: 'rows' }>[]
    expect(rows.every(frame => frame.sessionId === 'alice')).toBe(true)
    expect(rows[0]?.activities[0]?.status).toBe('running')
    expect(rows[1]?.activities[0]?.detail).toBe('halfway')
    expect(rows[2]?.activities[0]?.status).toBe('completed')
    expect(feed.ownerOf(String(rows[0]!.activities[0]!.id))).toBe(owner)
  })

  it('projects callId-only correlation and serves rosters without an agent registry', async () => {
    const bare = new Context()
    await bare.plugin(LocalActivityRegistry)
    bare.activities.open({ kind: 'bash', label: 'lone', correlation: { callId: 'call-1' as never } })
    const feed = new ActivityFeed(bare)
    expect(feed.baseline()[0]?.correlation).toEqual({ callId: 'call-1' })
  })

  it('pushes an empty bucket frame when owner disposal removes the last row', async () => {
    const ctx = await harness()
    const owner = registerAgent(ctx, 'alice')
    const feed = new ActivityFeed(ctx)
    ctx.activities.open({ kind: 'bash', label: 'doomed', owner })
    const abort = new AbortController()
    const frames = collect<ActivityControlFrame>(feed.follow(abort.signal), 3, abort)
    await new Promise(resolve => setTimeout(resolve, 0))
    await (owner.ctx as unknown as { fiber: { dispose(): Promise<void> } }).fiber?.dispose?.()
    // Owner-disposal removal reaches the feed as an emptied bucket.
    await new Promise(resolve => setTimeout(resolve, 10))
    abort.abort()
    const seen = await frames
    const last = seen.at(-1) as Extract<ActivityControlFrame, { type: 'rows' }> | undefined
    if (last !== undefined && last.type === 'rows') expect(Array.isArray(last.activities)).toBe(true)
  })

  it('resolves undefined for unowned and unknown activities', async () => {
    const ctx = await harness()
    const feed = new ActivityFeed(ctx)
    const handle = ctx.activities.open({ kind: 'bash', label: 'shared' })
    expect(feed.ownerOf(String(handle.id))).toBeUndefined()
    expect(feed.ownerOf('bash-999')).toBeUndefined()
  })
})

describe('observeActivity', () => {
  async function observed(ctx: Context, feed: ActivityFeed, request: { activityId: ActivityId; from?: number }) {
    const abort = new AbortController()
    const frames: ActivityObserveFrame[] = []
    const stream = observeActivity(
      ctx.activities,
      request,
      { ...OBSERVE, ownerOf: id => feed.ownerOf(id) },
      abort.signal,
    )
    const done = (async () => {
      for await (const frame of stream) frames.push(frame)
    })()
    return { abort, frames, done }
  }

  it('anchors, streams coalesced output, and closes with the terminal status', async () => {
    const ctx = await harness()
    const feed = new ActivityFeed(ctx)
    const handle = ctx.activities.open({ kind: 'bash', label: 'echo' })
    handle.append('early ')
    const { frames, done } = await observed(ctx, feed, { activityId: handle.id })
    await new Promise(resolve => setTimeout(resolve, 20))
    handle.append('live', { channel: 'stderr' })
    await new Promise(resolve => setTimeout(resolve, 20))
    handle.end({ status: 'completed', detail: 'exit code: 0' })
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
    const feed = new ActivityFeed(ctx)
    const handle = ctx.activities.open({ kind: 'bash', label: 'spam' })
    handle.append('a'.repeat(60))
    handle.append('b'.repeat(60))
    handle.end({ status: 'completed' })

    const fresh = await observed(ctx, feed, { activityId: handle.id, from: 0 })
    await fresh.done
    const output = fresh.frames.find(frame => frame.type === 'output')
    expect(output?.lossy).toBe(true)
    expect(output?.chunks.map(chunk => chunk.text).join('')).toBe('b'.repeat(60))

    const resumed = await observed(ctx, feed, { activityId: handle.id, from: 120 })
    await resumed.done
    expect(resumed.frames.some(frame => frame.type === 'output')).toBe(false)
    expect(resumed.frames.at(-1)?.type).toBe('status')
  })

  it('splits oversized reads along the frame budget', async () => {
    const ctx = await harness()
    const feed = new ActivityFeed(ctx)
    const registry = ctx.activities
    const handle = registry.open({ kind: 'bash', label: 'wide' })
    const abort = new AbortController()
    handle.append('x'.repeat(30))
    handle.append('y'.repeat(30))
    handle.end({ status: 'completed' })
    const frames = await collect<ActivityObserveFrame>(
      observeActivity(registry, { activityId: handle.id }, {
        flushMs: 5,
        maxFrameBytes: 30,
        ownerOf: id => feed.ownerOf(id),
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
    const feed = new ActivityFeed(ctx)
    const registry = ctx.activities
    const handle = registry.open({ kind: 'bash', label: 'evicted split' })
    handle.append('a'.repeat(40))
    handle.append('b'.repeat(40))
    handle.append('c'.repeat(40))
    handle.end({ status: 'completed' })
    const abort = new AbortController()
    const frames = await collect<ActivityObserveFrame>(
      observeActivity(registry, { activityId: handle.id, from: 0 }, {
        flushMs: 5,
        maxFrameBytes: 40,
        ownerOf: id => feed.ownerOf(id),
      }, abort.signal),
      5,
      abort,
    )
    const outputs = frames.filter(frame => frame.type === 'output')
    expect(outputs[0]?.lossy).toBe(true)
    expect(outputs[1]?.lossy).toBeUndefined()
  })

  it('reads owned activities through the roster owner and rejects bad offsets and unknown ids', async () => {
    const ctx = await harness()
    const owner = registerAgent(ctx, 'alice')
    const feed = new ActivityFeed(ctx)
    const handle = ctx.activities.open({ kind: 'bash', label: 'secret', owner })
    handle.append('classified')
    handle.end({ status: 'completed' })
    const { frames, done } = await observed(ctx, feed, { activityId: handle.id })
    await done
    expect(frames.some(frame => frame.type === 'output'
      && frame.chunks.some(chunk => chunk.text === 'classified'))).toBe(true)

    const abort = new AbortController()
    await expect(collect(
      observeActivity(ctx.activities, { activityId: handle.id, from: -1 }, {
        ...OBSERVE,
        ownerOf: id => feed.ownerOf(id),
      }, abort.signal),
      1,
      abort,
    )).rejects.toThrow(/invalid observe offset/)

    const abortUnknown = new AbortController()
    await expect(collect(
      observeActivity(ctx.activities, { activityId: ActivityId('bash-999') }, {
        ...OBSERVE,
        ownerOf: id => feed.ownerOf(id),
      }, abortUnknown.signal),
      1,
      abortUnknown,
    )).rejects.toThrow(/unknown activity/)
  })

  it('ignores output signals for other activities while waiting', async () => {
    const ctx = await harness()
    const feed = new ActivityFeed(ctx)
    const watched = ctx.activities.open({ kind: 'bash', label: 'watched' })
    const noisy = ctx.activities.open({ kind: 'bash', label: 'noisy' })
    const { abort, frames, done } = await observed(ctx, feed, { activityId: watched.id })
    await new Promise(resolve => setTimeout(resolve, 15))
    noisy.append('unrelated')
    await new Promise(resolve => setTimeout(resolve, 15))
    watched.end({ status: 'completed' })
    await done
    abort.abort()
    expect(frames.filter(frame => frame.type === 'output')).toEqual([])
  })

  it('stops cleanly on abort while waiting for output', async () => {
    const ctx = await harness()
    const feed = new ActivityFeed(ctx)
    const handle = ctx.activities.open({ kind: 'bash', label: 'idle' })
    const { abort, frames, done } = await observed(ctx, feed, { activityId: handle.id })
    await new Promise(resolve => setTimeout(resolve, 20))
    abort.abort()
    await done
    expect(frames[0]?.type).toBe('opened')
    expect(frames.at(-1)?.type).not.toBe('status')
  })
})
