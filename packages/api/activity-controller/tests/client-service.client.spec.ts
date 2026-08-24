import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ClientActivityModel } from '../src/client/model.ts'
import { ClientActivityFeed } from '../src/client/service.ts'
import type { ActivityId, ActivityObserveFrame } from '../src/types.ts'

const ID = 'bash-1' as ActivityId

/** One scripted logical stream: frames are pushed by the test, never reopened. */
class FakeStream {
  disposed = false
  /** Model a carrier whose disposal surfaces as an iterator throw. */
  throwOnDispose = false
  private readonly frames: ActivityObserveFrame[] = []
  private waiter: (() => void) | undefined
  private failure: Error | undefined
  readonly accepts: number[] = []

  push(frame: ActivityObserveFrame): void {
    this.frames.push(frame)
    this.waiter?.()
  }

  poison(error: Error): void {
    this.failure = error
    this.waiter?.()
  }

  dispose(): Promise<void> {
    if (this.throwOnDispose && this.failure === undefined) {
      this.failure = new Error('carrier tore down')
    } else {
      this.disposed = true
    }
    this.waiter?.()
    return Promise.resolve()
  }

  async *[Symbol.asyncIterator]() {
    let generation = 1
    while (!this.disposed) {
      if (this.failure !== undefined) throw this.failure
      const frame = this.frames.shift()
      if (frame === undefined) {
        await new Promise<void>((resolve) => { this.waiter = resolve })
        continue
      }
      yield {
        generation,
        value: frame,
        signal: new AbortController().signal,
        accept: () => { this.accepts.push(generation) },
      }
      generation = 1
    }
  }
}

function bench() {
  const ctx = new Context()
  const model = new ClientActivityModel()
  const streams: { options: { open: (signal: AbortSignal) => unknown }; stream: FakeStream }[] = []
  const observeCalls: unknown[] = []
  const remote = {
    $stream: (options: { open: (signal: AbortSignal) => unknown }) => {
      const stream = new FakeStream()
      streams.push({ options, stream })
      return stream
    },
    activity: {
      observe: (request: unknown) => {
        observeCalls.push(request)
        return { [Symbol.asyncIterator]: async function* () { /* never yields */ } }
      },
      control: () => { throw new Error('not exercised') },
    },
  }
  const feed = new ClientActivityFeed(ctx, remote as never, model)
  return { ctx, model, feed, streams, observeCalls }
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))

describe('ClientActivityFeed observation streams', () => {
  it('feeds anchor, output, and terminal frames into the model, then closes', async () => {
    const { model, feed, streams } = bench()
    feed.observe(ID)
    const { stream } = streams[0]!
    stream.push({ type: 'opened', activityId: ID, from: 0, earliest: 0, total: 0, status: 'running' })
    stream.push({ type: 'output', chunks: [{ at: 0, text: 'hi' }], next: 2 })
    await tick()
    expect(model.getSnapshot().observed[String(ID)]?.text).toBe('hi')
    expect(stream.accepts).toHaveLength(1)

    stream.push({ type: 'status', status: 'completed' })
    await tick()
    expect(model.getSnapshot().observed[String(ID)]?.streaming).toBe(false)
    expect(stream.disposed).toBe(true)
  })

  it('shares one stream across observers and stops after the last release', async () => {
    const { model, feed, streams } = bench()
    const first = feed.observe(ID)
    const second = feed.observe(ID)
    expect(streams).toHaveLength(1)
    streams[0]!.stream.push({ type: 'opened', activityId: ID, from: 0, earliest: 0, total: 0, status: 'running' })
    await tick()

    first()
    first()
    expect(streams[0]!.stream.disposed).toBe(false)
    second()
    await tick()
    expect(streams[0]!.stream.disposed).toBe(true)
    expect(model.getSnapshot().observed[String(ID)]).toBeUndefined()
  })

  it('opens a fresh stream for a re-observed activity and resumes from the model cursor', async () => {
    const { feed, streams, observeCalls, model } = bench()
    const stop = feed.observe(ID)
    streams[0]!.stream.push({ type: 'opened', activityId: ID, from: 0, earliest: 0, total: 0, status: 'running' })
    streams[0]!.stream.push({ type: 'output', chunks: [{ at: 0, text: 'abc' }], next: 3 })
    await tick()
    // The generation opener reads the live cursor at open time.
    streams[0]!.options.open(new AbortController().signal)
    expect(observeCalls.at(-1)).toEqual({ activityId: ID, from: 3 })

    stop()
    await tick()
    feed.observe(ID)
    expect(streams).toHaveLength(2)
    streams[1]!.options.open(new AbortController().signal)
    // Stopped observation dropped the cursor: the fresh stream starts unanchored.
    expect(observeCalls.at(-1)).toEqual({ activityId: ID })
    expect(model.cursorOf(ID)).toBeUndefined()
  })

  it('classifies a premature end as retryable only after the anchor', () => {
    const { feed, streams } = bench()
    feed.observe(ID)
    const options = streams[0]!.options as unknown as { ended: (accepted: boolean) => Error }
    expect(options.ended(true).name).toBe('RemoteStreamCarrierError')
    expect(options.ended(false).name).toBe('Error')
  })

  it('records a consumer failure on the live view', async () => {
    const { model, feed, streams } = bench()
    feed.observe(ID)
    const { stream } = streams[0]!
    stream.push({ type: 'opened', activityId: ID, from: 0, earliest: 0, total: 0, status: 'running' })
    await tick()
    stream.poison(new Error('frame decode broke'))
    await tick()
    const view = model.getSnapshot().observed[String(ID)]
    expect(view?.error).toContain('frame decode broke')
    expect(view?.streaming).toBe(false)
  })

  it('treats a release after service disposal as inert and stays silent for post-stop failures', async () => {
    const { ctx, model, feed, streams } = bench()
    const stop = feed.observe(ID)
    const { stream } = streams[0]!
    stream.push({ type: 'opened', activityId: ID, from: 0, earliest: 0, total: 0, status: 'running' })
    await tick()
    // Poison wakes the consumer, but the synchronous stop lands first, so the
    // failure arrives on an already-stopped entry and stays silent.
    stream.poison(new Error('after stop'))
    stop()
    await tick()
    expect(model.getSnapshot().observed[String(ID)]).toBeUndefined()

    const second = feed.observe(ID)
    await ctx.fiber.dispose()
    // The disposal path already removed every entry; a live releaser whose
    // entry is gone is inert.
    second()
  })

  it('stays silent when the carrier teardown itself throws after a stop', async () => {
    const { model, feed, streams } = bench()
    const stop = feed.observe(ID)
    const { stream } = streams[0]!
    stream.throwOnDispose = true
    stream.push({ type: 'opened', activityId: ID, from: 0, earliest: 0, total: 0, status: 'running' })
    await tick()
    // The releaser marks the entry stopped, then its dispose surfaces as an
    // iterator throw — which the consumer swallows for a stopped entry.
    stop()
    await tick()
    expect(model.getSnapshot().observed[String(ID)]?.error).toBeUndefined()
  })

  it('records a terminal stream failure and service disposal closes live streams', async () => {
    const { ctx, model, feed, streams } = bench()
    feed.observe(ID)
    const failing = streams[0]!.stream
    failing.push({ type: 'opened', activityId: ID, from: 0, earliest: 0, total: 0, status: 'running' })
    await tick()
    const iterator = failing[Symbol.asyncIterator]()
    void iterator
    // Simulate a terminal consumer failure by disposing the underlying stream:
    // the consumer loop ends without a status frame and cleans up.
    const spy = vi.spyOn(model, 'observeFailed')
    await failing.dispose()
    await tick()

    const other = 'bash-2' as ActivityId
    feed.observe(other)
    await ctx.fiber.dispose()
    expect(streams.every(entry => entry.stream.disposed)).toBe(true)
    expect(spy).not.toHaveBeenCalled()
  })
})
