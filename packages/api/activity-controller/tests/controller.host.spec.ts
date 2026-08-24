import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LocalActivityRegistry from '@deepseek-ai/dsh-activity-local'
import { ActivityController } from '../src/index.ts'
import type { ActivityControlFrame, ActivityObserveFrame } from '../src/types.ts'

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

describe('ActivityController', () => {
  it('closes live roster followers when the owning fiber unwinds', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalActivityRegistry)
    const controller = new ActivityController(ctx, { flushMs: 5, maxFrameBytes: 1024 })
    const abort = new AbortController()
    const iterator = controller.control(abort.signal)[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toMatchObject({ type: 'baseline' })
    const pending = iterator.next()
    await ctx.fiber.dispose()
    // The feed effect closed the follower, ending the generation cleanly.
    expect((await pending).done).toBe(true)
  })

  it('coalesces bursts that land inside the flush window and carries the anchor detail', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalActivityRegistry)
    const controller = new ActivityController(ctx, { flushMs: 30, maxFrameBytes: 1024 })
    const handle = ctx.activities.open({ kind: 'bash', label: 'burst' })
    handle.updateDetail('warming up')
    const abort = new AbortController()
    const frames: ActivityObserveFrame[] = []
    const done = (async () => {
      for await (const frame of controller.observe({ activityId: handle.id }, abort.signal)) frames.push(frame)
    })()
    await new Promise(resolve => setTimeout(resolve, 10))
    handle.append('a')
    await new Promise(resolve => setTimeout(resolve, 5))
    // Lands inside the flush sleep, so the waiter is already dirty at the next wait.
    handle.append('b')
    await new Promise(resolve => setTimeout(resolve, 80))
    handle.end({ status: 'completed' })
    await done
    expect(frames[0]).toMatchObject({ type: 'opened', detail: 'warming up' })
    const text = frames.filter(frame => frame.type === 'output')
      .flatMap(frame => frame.chunks.map(chunk => chunk.text)).join('')
    expect(text).toBe('ab')
  })

  it('serves an empty baseline and refuses observation without the registry', async () => {
    const ctx = new Context()
    const controller = new ActivityController(ctx, { flushMs: 5, maxFrameBytes: 1024 })
    const abort = new AbortController()
    const frames = await collect<ActivityControlFrame>(controller.control(abort.signal), 1, abort)
    expect(frames).toEqual([{ type: 'baseline', activities: [] }])
    expect(() => controller.observe({ activityId: 'bash-1' as never }, new AbortController().signal))
      .toThrow(/activity observation unavailable/)
  })

  it('streams the roster and one activity end to end over a live registry', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalActivityRegistry)
    const controller = new ActivityController(ctx, { flushMs: 5, maxFrameBytes: 1024 })

    const handle = ctx.activities.open({ kind: 'bash', label: 'echo' })
    handle.append('hi')
    handle.end({ status: 'completed', detail: 'exit code: 0' })

    const rosterAbort = new AbortController()
    const roster = await collect<ActivityControlFrame>(controller.control(rosterAbort.signal), 1, rosterAbort)
    expect(roster[0]).toMatchObject({ type: 'baseline' })
    expect((roster[0] as Extract<ActivityControlFrame, { type: 'baseline' }>).activities[0]?.label).toBe('echo')

    const observeAbort = new AbortController()
    const observed = await collect<ActivityObserveFrame>(
      controller.observe({ activityId: handle.id }, observeAbort.signal),
      3,
      observeAbort,
    )
    expect(observed.map(frame => frame.type)).toEqual(['opened', 'output', 'status'])
  })
})
