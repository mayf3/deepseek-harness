/**
 * React-free client job-record observation state: per-job accumulated output
 * views fed by `job.observe` frames. Pure data plus subscriptions — transport
 * wiring stays in the client service, UI stays in slot components.
 * @module @deepseek-ai/dsh-api-job-controller/client/model
 */

import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import type { JobId } from '@deepseek-ai/dsh-jobs/brand'
import type { JobObserveFrame, JobObserveStatus } from '../types.ts'

/** Bounded per-job render tail, in UTF-16 code units. */
const RENDER_TAIL_LIMIT = 128 * 1024

/** One observed job's live view state. */
export interface ObservedJob {
  readonly jobId: JobId
  /** Accumulated output tail, bounded to the render limit. */
  readonly text: string
  /** True when bytes before {@link text} were dropped (eviction, resume gap, or the render bound). */
  readonly gapBefore: boolean
  /** Latest status delivered on the observation stream. */
  readonly status: JobObserveStatus
  readonly detail?: string
  /** True while the observation stream is open and the job has not settled. */
  readonly streaming: boolean
  /** Terminal observation failure, when the stream ended abnormally. */
  readonly error?: string
}

/** Immutable client job-output state. */
export interface JobOutputSnapshot {
  /** Live observation state keyed by job id. */
  readonly observed: Readonly<Record<string, ObservedJob>>
}

/** Bare observable source for the client job-output snapshot. */
export interface JobOutputSource {
  /** Read the identity-stable current snapshot. */
  getSnapshot(): JobOutputSnapshot
  /**
   * Subscribe to snapshot changes.
   * @param listener - invalidation callback.
   * @returns unsubscribe function.
   */
  subscribe(listener: () => void): () => void
}

/** Mutable observation bookkeeping behind one {@link ObservedJob} view. */
interface ObservedState {
  view: ObservedJob
  /** Resume offset for the next generation's `from`. */
  cursor: number | undefined
}

/** Owns per-job observation state. */
export class ClientJobOutputModel implements JobOutputSource {
  private readonly observedStates = new Map<string, ObservedState>()
  private readonly listeners = new Set<() => void>()
  private snapshotCache: JobOutputSnapshot = { observed: {} }
  private snapshotDirty = false

  getSnapshot(): JobOutputSnapshot {
    if (this.snapshotDirty) {
      const observed: Record<string, ObservedJob> = {}
      for (const [id, state] of this.observedStates) observed[id] = state.view
      this.snapshotCache = { observed }
      this.snapshotDirty = false
    }
    return this.snapshotCache
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * The resume offset for one job's next observation generation.
   * @param id - observed job.
   * @returns the last accepted `next`, or undefined for a fresh observation.
   */
  cursorOf(id: JobId): number | undefined {
    return this.observedStates.get(String(id))?.cursor
  }

  /**
   * Install or reset observation state when a generation's anchor arrives.
   * @param id - observed job.
   * @param frame - the generation's `opened` anchor.
   */
  observeOpened(id: JobId, frame: Extract<JobObserveFrame, { type: 'opened' }>): void {
    const existing = this.observedStates.get(String(id))
    // A fresh view anchored past offset zero starts after an evicted head
    // (fresh observations anchor at the registry's earliest retained byte), so
    // it owes the same gap mark a live observer earned from lossy reads. A
    // resume that already accumulated text keeps its recorded gap state.
    const freshPastHead = (existing === undefined || existing.view.text === '') && frame.from > 0
    const view: ObservedJob = {
      jobId: id,
      text: existing?.view.text ?? '',
      gapBefore: (existing?.view.gapBefore ?? false) || frame.from < frame.earliest || freshPastHead,
      status: frame.status,
      ...frame.detail !== undefined ? { detail: frame.detail } : {},
      streaming: true,
    }
    this.observedStates.set(String(id), { view, cursor: frame.from })
    this.changed()
  }

  /**
   * Append one output frame's chunks to the bounded render tail.
   * @param id - observed job.
   * @param frame - a coalesced `output` frame.
   */
  observeOutput(id: JobId, frame: Extract<JobObserveFrame, { type: 'output' }>): void {
    const state = this.observedStates.get(String(id))
    /* v8 ignore next -- frames arrive only between opened and stop for a tracked id. */
    if (state === undefined) return
    let text = state.view.text + frame.chunks.map(chunk => chunk.text).join('')
    let gapBefore = state.view.gapBefore || frame.lossy === true
      || frame.chunks.some(chunk => chunk.gapBefore === true)
    if (text.length > RENDER_TAIL_LIMIT) {
      let cut = text.length - RENDER_TAIL_LIMIT
      // Never split a surrogate pair at the render bound.
      const unit = text.charCodeAt(cut)
      if (unit >= 0xDC00 && unit <= 0xDFFF) cut += 1
      text = text.slice(cut)
      gapBefore = true
    }
    state.view = { ...state.view, text, gapBefore }
    state.cursor = frame.next
    this.changed()
  }

  /**
   * Record the terminal status delivered at the end of the observation stream.
   * @param id - observed job.
   * @param frame - the terminal `status` frame.
   */
  observeStatus(id: JobId, frame: Extract<JobObserveFrame, { type: 'status' }>): void {
    const state = this.observedStates.get(String(id))
    /* v8 ignore next -- frames arrive only between opened and stop for a tracked id. */
    if (state === undefined) return
    state.view = {
      ...state.view,
      status: frame.status,
      ...frame.detail !== undefined ? { detail: frame.detail } : {},
      streaming: false,
    }
    this.changed()
  }

  /**
   * Record a terminal observation failure.
   * @param id - observed job.
   * @param error - the stream's terminal failure.
   */
  observeFailed(id: JobId, error: unknown): void {
    const state = this.observedStates.get(String(id))
    if (state === undefined) return
    state.view = { ...state.view, streaming: false, error: String(error) }
    this.changed()
  }

  /**
   * Drop observation state after the last observer stops.
   * @param id - the no-longer-observed job.
   */
  observeStopped(id: JobId): void {
    if (!this.observedStates.delete(String(id))) return
    this.changed()
  }

  private changed(): void {
    this.snapshotDirty = true
    notifySubscribers(this.listeners, 'job output')
  }
}
