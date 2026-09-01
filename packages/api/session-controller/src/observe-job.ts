/** Per-job record observation generations: anchor, coalesced output, terminal status. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobId } from '@deepseek-ai/dsh-jobs/brand'
import type { JobRegistry, JobSnapshot } from '@deepseek-ai/dsh-jobs'
import type { SessionJobWireChunk, SessionObserveJobFrame, SessionObserveJobRequest } from './types.ts'

/** Cadence and framing bounds for one observation generation. */
export interface ObserveJobOptions {
  /** Coalescing window after a wake before reading, in milliseconds. */
  readonly flushMs: number
  /**
   * Soft byte budget per `output` frame. Accumulated chunks flush once the
   * budget is met; one chunk larger than the budget ships whole (the
   * registry's retention cap is the hard bound on any single chunk).
   */
  readonly maxFrameBytes: number
  /** The live owning agent for fenced reads, resolved from the request's session. */
  readonly caller: Agent | undefined
}

function isTerminal(status: JobSnapshot['status']): boolean {
  return status !== 'running' && status !== 'stopping'
}

/** A record job's total offset; the anchor check proved the declaration and it never leaves. */
function recordTotal(snapshot: JobSnapshot): number {
  /* v8 ignore next -- a declared record never loses its offsets. */
  return snapshot.outputTotal ?? 0
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
 * Stream one job's retained record output from an absolute offset: one
 * `opened` anchor, coalesced `output` frames as the record advances, then one
 * terminal `status` after the settled job is drained, after which the
 * generation closes normally. Reads are non-consuming — the model-facing
 * cursor and notice state never observe them; reconnecting callers resume by
 * passing the last frame's `next` as `from`. Throws for a job that declared
 * no record.
 * @param registry - the live job registry.
 * @param request - target job and optional resume offset.
 * @param options - cadence, framing bounds, and the fenced-read caller.
 * @param signal - generation cancellation owned by the Remote stream carrier.
 * @returns the observation frame sequence for one generation.
 */
export async function* observeJobRecord(
  registry: JobRegistry,
  request: SessionObserveJobRequest,
  options: ObserveJobOptions,
  signal: AbortSignal,
): AsyncIterable<SessionObserveJobFrame> {
  if (request.from !== undefined && (!Number.isSafeInteger(request.from) || request.from < 0)) {
    throw new Error(`invalid observe offset: expected a non-negative safe integer, got ${JSON.stringify(request.from)}`)
  }
  signal.throwIfAborted()
  // The brand is nominal typing only; the wire boundary stamps it here rather
  // than value-importing the optional registry package's constructor.
  const id = String(request.jobId) as JobId
  const waiter = new OutputWaiter()
  // Subscribe before the first read so an append between the anchor read and
  // the wait cannot be missed.
  const unsubscribe = registry.onOutput((changed) => {
    if (changed === id) waiter.wake()
  })
  try {
    const caller = options.caller
    let snapshot = registry.get(id, caller)
    if (snapshot.outputTotal === undefined || snapshot.outputEarliest === undefined) {
      throw new Error(`job ${id} declared no output record`)
    }
    let cursor = request.from ?? snapshot.outputEarliest
    yield {
      type: 'opened',
      jobId: id,
      from: cursor,
      earliest: snapshot.outputEarliest,
      total: snapshot.outputTotal,
      status: snapshot.status,
      ...snapshot.detail !== undefined ? { detail: snapshot.detail } : {},
    }
    while (!signal.aborted) {
      const read = registry.readRecord(id, cursor, caller)
      if (read.chunks.length > 0) {
        yield* outputFrames(read.chunks, read.next, read.lossy, options.maxFrameBytes)
      }
      cursor = read.next
      snapshot = registry.get(id, caller)
      if (isTerminal(snapshot.status) && cursor >= recordTotal(snapshot)) {
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
  chunks: readonly SessionJobWireChunk[],
  next: number,
  lossy: boolean,
  maxFrameBytes: number,
): Iterable<SessionObserveJobFrame> {
  let batch: SessionJobWireChunk[] = []
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
