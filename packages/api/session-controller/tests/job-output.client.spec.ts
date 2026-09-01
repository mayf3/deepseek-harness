import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { JobId } from '@deepseek-ai/dsh-jobs/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ClientJobOutput, ClientJobOutputModel } from '../src/client/job-output.ts'
import type { SessionObserveJobFrame } from '../src/types.ts'

const ID = 'bash-1' as JobId

function opened(model: ClientJobOutputModel, over: Partial<{ from: number; earliest: number; total: number }> = {}): void {
  model.observeOpened(ID, {
    type: 'opened',
    jobId: ID,
    from: 0,
    earliest: 0,
    total: 0,
    status: 'running',
    ...over,
  })
}

describe('ClientJobOutputModel observation', () => {
  it('accumulates output, advances the resume cursor, and settles on status', () => {
    const model = new ClientJobOutputModel()
    opened(model)
    expect(model.cursorOf(ID)).toBe(0)
    model.observeOutput(ID, { type: 'output', chunks: [{ at: 0, text: 'a' }, { at: 1, text: 'b' }], next: 2 })
    model.observeOutput(ID, { type: 'output', chunks: [{ at: 2, text: 'c' }], next: 3 })
    expect(model.cursorOf(ID)).toBe(3)
    const view = model.getSnapshot().observed[String(ID)]
    expect(view?.text).toBe('abc')
    expect(view?.streaming).toBe(true)
    model.observeStatus(ID, { type: 'status', status: 'completed', detail: 'exit code: 0' })
    const settled = model.getSnapshot().observed[String(ID)]
    expect(settled?.streaming).toBe(false)
    expect(settled?.status).toBe('completed')
    expect(settled?.detail).toBe('exit code: 0')
  })

  it('keeps snapshot identity stable between changes and notifies subscribers', () => {
    const model = new ClientJobOutputModel()
    let notified = 0
    const unsubscribe = model.subscribe(() => { notified += 1 })
    const before = model.getSnapshot()
    expect(model.getSnapshot()).toBe(before)
    opened(model)
    expect(notified).toBe(1)
    expect(model.getSnapshot()).not.toBe(before)
    unsubscribe()
    model.observeStopped(ID)
    expect(notified).toBe(1)
  })

  it('marks gaps from lossy frames, gap chunks, and a resume behind the retained head', () => {
    const model = new ClientJobOutputModel()
    opened(model, { from: 4, earliest: 8, total: 10 })
    expect(model.getSnapshot().observed[String(ID)]?.gapBefore).toBe(true)

    const clean = new ClientJobOutputModel()
    opened(clean)
    clean.observeOutput(ID, { type: 'output', chunks: [{ at: 0, text: 'x', gapBefore: true }], next: 1 })
    expect(clean.getSnapshot().observed[String(ID)]?.gapBefore).toBe(true)

    const lossy = new ClientJobOutputModel()
    opened(lossy)
    lossy.observeOutput(ID, { type: 'output', chunks: [], next: 5, lossy: true })
    expect(lossy.getSnapshot().observed[String(ID)]?.gapBefore).toBe(true)
  })

  it('marks a fresh observation anchored past the evicted head', () => {
    // Fresh observations anchor at the registry's earliest retained byte, so
    // from === earliest > 0 means the head was already discarded.
    const fresh = new ClientJobOutputModel()
    opened(fresh, { from: 60_240, earliest: 60_240, total: 321_328 })
    expect(fresh.getSnapshot().observed[String(ID)]?.gapBefore).toBe(true)

    // A retry that accumulated no text yet earns the mark the same way.
    const retried = new ClientJobOutputModel()
    opened(retried)
    expect(retried.getSnapshot().observed[String(ID)]?.gapBefore).toBe(false)
    opened(retried, { from: 6, earliest: 6, total: 6 })
    expect(retried.getSnapshot().observed[String(ID)]?.gapBefore).toBe(true)
  })

  it('bounds the render tail without splitting a surrogate pair', () => {
    const model = new ClientJobOutputModel()
    opened(model)
    const emoji = '😀'.repeat((64 * 1024) + 8)
    model.observeOutput(ID, { type: 'output', chunks: [{ at: 0, text: emoji }], next: emoji.length * 2 })
    const view = model.getSnapshot().observed[String(ID)]
    expect(view?.gapBefore).toBe(true)
    expect(view!.text.length).toBeLessThanOrEqual(128 * 1024)
    // The bound landed between pairs: the surviving text still round-trips.
    expect(/^(?:😀)+$/u.test(view!.text)).toBe(true)
  })

  it('carries the anchor detail and trims a plain-ASCII tail without a boundary shift', () => {
    const model = new ClientJobOutputModel()
    model.observeOpened(ID, {
      type: 'opened', jobId: ID, from: 0, earliest: 0, total: 0, status: 'running', detail: 'exit soon',
    })
    expect(model.getSnapshot().observed[String(ID)]?.detail).toBe('exit soon')
    const long = 'x'.repeat((128 * 1024) + 5)
    model.observeOutput(ID, { type: 'output', chunks: [{ at: 0, text: long }], next: long.length })
    const view = model.getSnapshot().observed[String(ID)]
    expect(view?.text.length).toBe(128 * 1024)
    expect(view?.gapBefore).toBe(true)
  })

  it('advances the cut past a low surrogate landing exactly on the bound', () => {
    const model = new ClientJobOutputModel()
    opened(model)
    // 'z' + one emoji + odd ASCII tail puts a low surrogate exactly at the cut index.
    const text = 'z😀' + 'a'.repeat((128 * 1024) - 1)
    model.observeOutput(ID, { type: 'output', chunks: [{ at: 0, text }], next: text.length })
    const view = model.getSnapshot().observed[String(ID)]
    expect(view?.text.length).toBe((128 * 1024) - 1)
    expect(view?.text.startsWith('a')).toBe(true)
  })

  it('preserves accumulated text across a reconnect anchor and clears on stop', () => {
    const model = new ClientJobOutputModel()
    opened(model)
    model.observeOutput(ID, { type: 'output', chunks: [{ at: 0, text: 'kept' }], next: 4 })
    opened(model, { from: 4, earliest: 0, total: 4 })
    expect(model.getSnapshot().observed[String(ID)]?.text).toBe('kept')
    model.observeStopped(ID)
    expect(model.getSnapshot().observed[String(ID)]).toBeUndefined()
    expect(model.cursorOf(ID)).toBeUndefined()
    // A second stop is inert.
    model.observeStopped(ID)
  })

  it('records a terminal stream failure on the live view', () => {
    const model = new ClientJobOutputModel()
    opened(model)
    model.observeFailed(ID, new Error('carrier gone'))
    const view = model.getSnapshot().observed[String(ID)]
    expect(view?.streaming).toBe(false)
    expect(view?.error).toContain('carrier gone')
    // A failure for an untracked id is inert.
    model.observeFailed('bash-9' as JobId, new Error('ignored'))
  })
})

/** One scripted logical stream: frames are pushed by the test, never reopened. */
class FakeStream {
  disposed = false
  /** Model a carrier whose disposal surfaces as an iterator throw. */
  throwOnDispose = false
  /** Hold the dispose promise open until {@link releaseDispose}. */
  deferDispose = false
  private disposeRelease: (() => void) | undefined
  private disposePending: Promise<void> | undefined
  private readonly frames: SessionObserveJobFrame[] = []
  private waiter: (() => void) | undefined
  private failure: Error | undefined
  readonly accepts: number[] = []

  push(frame: SessionObserveJobFrame): void {
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
    if (this.deferDispose) {
      // Repeat disposals (releaser plus the consumer's finally) share one
      // deferred promise, so releaseDispose resumes every waiter.
      this.disposePending ??= new Promise((resolve) => { this.disposeRelease = resolve })
      return this.disposePending
    }
    return Promise.resolve()
  }

  releaseDispose(): void {
    this.disposeRelease?.()
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
  const model = new ClientJobOutputModel()
  const streams: { options: { open: (signal: AbortSignal) => unknown }; stream: FakeStream }[] = []
  const observeCalls: unknown[] = []
  const remote = {
    $stream: (options: { open: (signal: AbortSignal) => unknown }) => {
      const stream = new FakeStream()
      streams.push({ options, stream })
      return stream
    },
    session: {
      observeJob: (request: unknown) => {
        observeCalls.push(request)
        return { [Symbol.asyncIterator]: async function* () { /* never yields */ } }
      },
    },
  }
  const output = new ClientJobOutput(ctx, remote as never, model)
  return { ctx, model, output, streams, observeCalls }
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))

describe('ClientJobOutput observation streams', () => {
  it('feeds anchor, output, and terminal frames into the model, then closes', async () => {
    const { model, output, streams } = bench()
    output.observe(undefined, ID)
    const { stream } = streams[0]!
    stream.push({ type: 'opened', jobId: ID, from: 0, earliest: 0, total: 0, status: 'running' })
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
    const { model, output, streams } = bench()
    const first = output.observe(undefined, ID)
    const second = output.observe(undefined, ID)
    expect(streams).toHaveLength(1)
    streams[0]!.stream.push({ type: 'opened', jobId: ID, from: 0, earliest: 0, total: 0, status: 'running' })
    await tick()

    first()
    first()
    expect(streams[0]!.stream.disposed).toBe(false)
    second()
    await tick()
    expect(streams[0]!.stream.disposed).toBe(true)
    expect(model.getSnapshot().observed[String(ID)]).toBeUndefined()
  })

  it('a late release of a superseded observation neither tears down nor clears its successor', async () => {
    const { model, output, streams } = bench()
    const firstStop = output.observe(undefined, ID)
    const first = streams[0]!.stream
    first.push({ type: 'opened', jobId: ID, from: 0, earliest: 0, total: 0, status: 'running' })
    first.push({ type: 'status', status: 'completed' })
    await tick()
    // A successor observation replaces the settled entry while the first
    // observer still holds its releaser.
    const secondStop = output.observe(undefined, ID)
    const second = streams[1]!.stream
    second.push({ type: 'opened', jobId: ID, from: 0, earliest: 0, total: 0, status: 'running' })
    await tick()

    firstStop()
    await tick()
    expect(second.disposed).toBe(false)
    expect(model.getSnapshot().observed[String(ID)]).toBeDefined()

    secondStop()
    await tick()
    expect(second.disposed).toBe(true)
    expect(model.getSnapshot().observed[String(ID)]).toBeUndefined()
  })

  it('a re-observation inside the dispose round-trip keeps its fresh view', async () => {
    const { model, output, streams } = bench()
    const stop = output.observe(undefined, ID)
    const first = streams[0]!.stream
    first.deferDispose = true
    first.push({ type: 'opened', jobId: ID, from: 0, earliest: 0, total: 0, status: 'running' })
    await tick()

    stop()
    // Re-expand while the previous generation's dispose is still in flight.
    output.observe(undefined, ID)
    const second = streams[1]!.stream
    second.push({ type: 'opened', jobId: ID, from: 0, earliest: 0, total: 0, status: 'running' })
    await tick()

    first.releaseDispose()
    await tick()
    // The stale post-dispose clear must not blank the successor's view.
    expect(model.getSnapshot().observed[String(ID)]).toBeDefined()
    second.push({ type: 'output', chunks: [{ at: 0, text: 'alive' }], next: 5 })
    await tick()
    expect(model.getSnapshot().observed[String(ID)]?.text).toBe('alive')
  })

  it('opens a fresh stream for a re-observed job and resumes from the model cursor', async () => {
    const { output, streams, observeCalls, model } = bench()
    const stop = output.observe('alice' as SessionId, ID)
    streams[0]!.stream.push({ type: 'opened', jobId: ID, from: 0, earliest: 0, total: 0, status: 'running' })
    streams[0]!.stream.push({ type: 'output', chunks: [{ at: 0, text: 'abc' }], next: 3 })
    await tick()
    // The generation opener reads the live cursor at open time and carries the
    // fenced-read session.
    streams[0]!.options.open(new AbortController().signal)
    expect(observeCalls.at(-1)).toEqual({ jobId: ID, sessionId: 'alice', from: 3 })

    stop()
    await tick()
    output.observe(undefined, ID)
    expect(streams).toHaveLength(2)
    streams[1]!.options.open(new AbortController().signal)
    // Stopped observation dropped the cursor: the fresh stream starts unanchored.
    expect(observeCalls.at(-1)).toEqual({ jobId: ID })
    expect(model.cursorOf(ID)).toBeUndefined()
  })

  it('classifies a premature end as retryable only after the anchor', () => {
    const { output, streams } = bench()
    output.observe(undefined, ID)
    const options = streams[0]!.options as unknown as { ended: (accepted: boolean) => Error }
    expect(options.ended(true).name).toBe('RemoteStreamCarrierError')
    expect(options.ended(false).name).toBe('Error')
  })

  it('records a consumer failure on the live view', async () => {
    const { model, output, streams } = bench()
    output.observe(undefined, ID)
    const { stream } = streams[0]!
    stream.push({ type: 'opened', jobId: ID, from: 0, earliest: 0, total: 0, status: 'running' })
    await tick()
    stream.poison(new Error('frame decode broke'))
    await tick()
    const view = model.getSnapshot().observed[String(ID)]
    expect(view?.error).toContain('frame decode broke')
    expect(view?.streaming).toBe(false)
  })

  it('treats a release after service disposal as inert and stays silent for post-stop failures', async () => {
    const { ctx, model, output, streams } = bench()
    const stop = output.observe(undefined, ID)
    const { stream } = streams[0]!
    stream.push({ type: 'opened', jobId: ID, from: 0, earliest: 0, total: 0, status: 'running' })
    await tick()
    // Poison wakes the consumer, but the synchronous stop lands first, so the
    // failure arrives on an already-stopped entry and stays silent.
    stream.poison(new Error('after stop'))
    stop()
    await tick()
    expect(model.getSnapshot().observed[String(ID)]).toBeUndefined()

    const second = output.observe(undefined, ID)
    await ctx.fiber.dispose()
    // The disposal path already removed every entry; a live releaser whose
    // entry is gone is inert.
    second()
  })

  it('stays silent when the carrier teardown itself throws after a stop', async () => {
    const { model, output, streams } = bench()
    const stop = output.observe(undefined, ID)
    const { stream } = streams[0]!
    stream.throwOnDispose = true
    stream.push({ type: 'opened', jobId: ID, from: 0, earliest: 0, total: 0, status: 'running' })
    await tick()
    // The releaser marks the entry stopped, then its dispose surfaces as an
    // iterator throw — which the consumer swallows for a stopped entry.
    stop()
    await tick()
    expect(model.getSnapshot().observed[String(ID)]?.error).toBeUndefined()
  })

  it('records a terminal stream failure and service disposal closes live streams', async () => {
    const { ctx, model, output, streams } = bench()
    output.observe(undefined, ID)
    const failing = streams[0]!.stream
    failing.push({ type: 'opened', jobId: ID, from: 0, earliest: 0, total: 0, status: 'running' })
    await tick()
    const iterator = failing[Symbol.asyncIterator]()
    void iterator
    // Simulate a terminal consumer failure by disposing the underlying stream:
    // the consumer loop ends without a status frame and cleans up.
    const spy = vi.spyOn(model, 'observeFailed')
    await failing.dispose()
    await tick()

    const other = 'bash-2' as JobId
    output.observe(undefined, other)
    await ctx.fiber.dispose()
    expect(streams.every(entry => entry.stream.disposed)).toBe(true)
    expect(spy).not.toHaveBeenCalled()
  })
})
