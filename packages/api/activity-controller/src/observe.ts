/** Per-activity observation generations: anchor, coalesced output, terminal status. */

import type { ActivityRegistry, ActivitySnapshot } from '@deepseek-ai/dsh-activity'
import { ActivityId } from '@deepseek-ai/dsh-activity/brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ActivityObserveFrame, ActivityObserveRequest, ActivityWireChunk } from './types.ts'

/** Cadence and framing bounds for one observation generation. */
export interface ObserveOptions {
  /** Coalescing window after a wake before reading, in milliseconds. */
  readonly flushMs: number
  /**
   * Soft byte budget per `output` frame. Accumulated chunks flush once the
   * budget is met; one chunk larger than the budget ships whole (the
   * registry's retention cap is the hard bound on any single chunk).
   */
  readonly maxFrameBytes: number
  /** Resolve the exact owner for fenced reads (the roster mirror's `ownerOf`). */
  readonly ownerOf: (id: string) => Agent | undefined
}

function isTerminal(status: ActivitySnapshot['status']): boolean {
  return status !== 'running'
}

/** Wake-flag waiter: a wake between waits is never lost. */
class OutputWaiter {
  private dirty = false
  private resolve: (() => void) | undefined

  wake(): void {
    this.dirty = true
    this.resolve?.()
  }

  /**
   * Resolve on the next wake, immediately when one already arrived, or on abort.
   * @param signal - generation cancellation.
   */
  wait(signal: AbortSignal): Promise<void> {
    if (this.dirty || signal.aborted) {
      this.dirty = false
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      const finish = (): void => {
        signal.removeEventListener('abort', finish)
        /* v8 ignore next -- one wait owns the sole installed resolver. */
        if (this.resolve === finish) this.resolve = undefined
        this.dirty = false
        resolve()
      }
      this.resolve = finish
      signal.addEventListener('abort', finish, { once: true })
    })
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

/**
 * Stream one activity's retained output from an absolute offset: one `opened`
 * anchor, coalesced `output` frames as the stream advances, then one terminal
 * `status` after the settled activity is drained, after which the generation
 * closes normally. Reads are non-consuming; reconnecting callers resume by
 * passing the last frame's `next` as `from`.
 * @param registry - the live activity registry.
 * @param request - target activity and optional resume offset.
 * @param options - cadence, framing bounds, and owner resolution.
 * @param signal - generation cancellation owned by the Remote stream carrier.
 * @returns the observation frame sequence for one generation.
 */
export async function* observeActivity(
  registry: ActivityRegistry,
  request: ActivityObserveRequest,
  options: ObserveOptions,
  signal: AbortSignal,
): AsyncIterable<ActivityObserveFrame> {
  if (request.from !== undefined && (!Number.isSafeInteger(request.from) || request.from < 0)) {
    throw new Error(`invalid observe offset: expected a non-negative safe integer, got ${JSON.stringify(request.from)}`)
  }
  signal.throwIfAborted()
  const id = ActivityId(String(request.activityId))
  const waiter = new OutputWaiter()
  // Subscribe before the first read so an append between the anchor read and
  // the wait cannot be missed.
  const unsubscribe = registry.onOutput((changed) => {
    if (changed === id) waiter.wake()
  })
  try {
    const caller = options.ownerOf(String(id))
    let snapshot = registry.get(id, caller)
    let cursor = request.from ?? snapshot.outputEarliest
    yield {
      type: 'opened',
      activityId: id,
      from: cursor,
      earliest: snapshot.outputEarliest,
      total: snapshot.outputTotal,
      status: snapshot.status,
      ...snapshot.detail !== undefined ? { detail: snapshot.detail } : {},
    }
    while (!signal.aborted) {
      const read = registry.read(id, cursor, caller)
      if (read.chunks.length > 0) {
        yield* outputFrames(read.chunks, read.next, read.lossy, options.maxFrameBytes)
      }
      cursor = read.next
      snapshot = registry.get(id, caller)
      if (isTerminal(snapshot.status) && cursor >= snapshot.outputTotal) {
        yield {
          type: 'status',
          status: snapshot.status,
          ...snapshot.detail !== undefined ? { detail: snapshot.detail } : {},
          // Settlement always stamps finishedAt; the guard only discharges the optional field type.
          /* v8 ignore next */
          ...snapshot.finishedAt !== undefined ? { finishedAt: snapshot.finishedAt } : {},
        }
        return
      }
      await waiter.wait(signal)
      // Let a burst accumulate so producer chatter becomes bounded frames.
      await sleep(options.flushMs, signal)
    }
  } finally {
    unsubscribe()
  }
}

/** Split one read into frames along the soft per-frame byte budget. */
function* outputFrames(
  chunks: readonly ActivityWireChunk[],
  next: number,
  lossy: boolean,
  maxFrameBytes: number,
): Iterable<ActivityObserveFrame> {
  let batch: ActivityWireChunk[] = []
  let batchBytes = 0
  let flaggedLossy = lossy
  for (const chunk of chunks) {
    batch.push(chunk)
    batchBytes += Buffer.byteLength(chunk.text, 'utf8')
    if (batchBytes >= maxFrameBytes) {
      const last = batch[batch.length - 1]
      /* v8 ignore start -- a non-empty batch always has a last chunk; the arm only discharges noUncheckedIndexedAccess. */
      const end = last === undefined ? next : last.at + Buffer.byteLength(last.text, 'utf8')
      /* v8 ignore stop */
      yield {
        type: 'output',
        chunks: batch,
        next: end,
        ...flaggedLossy ? { lossy: true as const } : {},
      }
      flaggedLossy = false
      batch = []
      batchBytes = 0
    }
  }
  if (batch.length > 0 || flaggedLossy) {
    yield {
      type: 'output',
      chunks: batch,
      next,
      ...flaggedLossy ? { lossy: true as const } : {},
    }
  }
}
