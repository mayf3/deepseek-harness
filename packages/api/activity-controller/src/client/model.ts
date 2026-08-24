/** Client-side activity state model shared by Remote transport and UI projection. */

import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import type { ActivityId } from '@deepseek-ai/dsh-activity/brand'
import type { ActivityObserveFrame, ActivityRow } from '../types.ts'

/** Bounded per-activity render tail, in UTF-16 code units. */
const RENDER_TAIL_LIMIT = 128 * 1024

/** Roster arrival lifecycle: `pending` until the first baseline lands. */
export type ActivityFeedPhase = 'pending' | 'ready'

/** One observed activity's live view state. */
export interface ObservedActivity {
  readonly activityId: ActivityId
  /** Accumulated output tail, bounded to the render limit. */
  readonly text: string
  /** True when bytes before {@link text} were dropped (eviction, resume gap, or the render bound). */
  readonly gapBefore: boolean
  /** Latest status delivered on the observation stream. */
  readonly status: ActivityRow['status']
  readonly detail?: string
  /** True while the observation stream is open and the activity has not settled. */
  readonly streaming: boolean
  /** Terminal observation failure, when the stream ended abnormally. */
  readonly error?: string
}

/** Immutable client activity state. */
export interface ActivityFeedSnapshot {
  /** Roster rows per owner session; the empty key holds unowned activities. */
  readonly rowsBySession: Readonly<Record<string, readonly ActivityRow[]>>
  /** Live observation state keyed by activity id. */
  readonly observed: Readonly<Record<string, ObservedActivity>>
  readonly phase: ActivityFeedPhase
}

const UNOWNED = ''

/** Mutable observation bookkeeping behind one {@link ObservedActivity} view. */
interface ObservedState {
  view: ObservedActivity
  /** Resume offset for the next generation's `from`. */
  cursor: number | undefined
}

/**
 * Owns the client roster mirror and per-activity observation state. Pure data
 * plus subscriptions — transport wiring stays in the client plugin, UI stays
 * in slot components.
 */
export class ClientActivityModel {
  private rowsBySession: Readonly<Record<string, readonly ActivityRow[]>> = {}
  private readonly observedStates = new Map<string, ObservedState>()
  private phase: ActivityFeedPhase = 'pending'
  private readonly listeners = new Set<() => void>()
  private snapshotCache: ActivityFeedSnapshot = { rowsBySession: {}, observed: {}, phase: 'pending' }
  private snapshotDirty = false

  /**
   * Read the identity-stable current snapshot.
   * @returns the cached snapshot, rebuilt only after a change.
   */
  getSnapshot(): ActivityFeedSnapshot {
    if (this.snapshotDirty) {
      const observed: Record<string, ObservedActivity> = {}
      for (const [id, state] of this.observedStates) observed[id] = state.view
      this.snapshotCache = { rowsBySession: this.rowsBySession, observed, phase: this.phase }
      this.snapshotDirty = false
    }
    return this.snapshotCache
  }

  /**
   * Subscribe to snapshot changes.
   * @param listener - invalidation callback.
   * @returns unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Replace the whole roster from a generation baseline.
   * @param rows - every visible row across all owner buckets.
   */
  replaceBaseline(rows: readonly ActivityRow[]): void {
    const next: Record<string, ActivityRow[]> = {}
    for (const row of rows) {
      const key = row.sessionId ?? UNOWNED
      ;(next[key] ??= []).push(row)
    }
    this.rowsBySession = next
    this.phase = 'ready'
    this.changed()
  }

  /**
   * Replace one owner bucket wholesale; an empty replacement drops the key.
   * @param sessionId - owner session, or undefined for the unowned bucket.
   * @param rows - the bucket's complete visible rows.
   */
  replaceBucket(sessionId: string | undefined, rows: readonly ActivityRow[]): void {
    const key = sessionId ?? UNOWNED
    if (rows.length === 0) {
      this.rowsBySession = Object.fromEntries(
        Object.entries(this.rowsBySession).filter(([bucket]) => bucket !== key))
    } else {
      this.rowsBySession = { ...this.rowsBySession, [key]: rows }
    }
    this.changed()
  }

  /**
   * The resume offset for one activity's next observation generation.
   * @param id - observed activity.
   * @returns the last accepted `next`, or undefined for a fresh observation.
   */
  cursorOf(id: ActivityId): number | undefined {
    return this.observedStates.get(String(id))?.cursor
  }

  /**
   * Install or reset observation state when a generation's anchor arrives.
   * @param id - observed activity.
   * @param frame - the generation's `opened` anchor.
   */
  observeOpened(id: ActivityId, frame: Extract<ActivityObserveFrame, { type: 'opened' }>): void {
    const existing = this.observedStates.get(String(id))
    const view: ObservedActivity = {
      activityId: id,
      text: existing?.view.text ?? '',
      gapBefore: (existing?.view.gapBefore ?? false) || frame.from < frame.earliest,
      status: frame.status,
      ...frame.detail !== undefined ? { detail: frame.detail } : {},
      streaming: true,
    }
    this.observedStates.set(String(id), { view, cursor: frame.from })
    this.changed()
  }

  /**
   * Append one output frame's chunks to the bounded render tail.
   * @param id - observed activity.
   * @param frame - a coalesced `output` frame.
   */
  observeOutput(id: ActivityId, frame: Extract<ActivityObserveFrame, { type: 'output' }>): void {
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
   * @param id - observed activity.
   * @param frame - the terminal `status` frame.
   */
  observeStatus(id: ActivityId, frame: Extract<ActivityObserveFrame, { type: 'status' }>): void {
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
   * @param id - observed activity.
   * @param error - the stream's terminal failure.
   */
  observeFailed(id: ActivityId, error: unknown): void {
    const state = this.observedStates.get(String(id))
    if (state === undefined) return
    state.view = { ...state.view, streaming: false, error: String(error) }
    this.changed()
  }

  /**
   * Drop observation state after the last observer stops.
   * @param id - the no-longer-observed activity.
   */
  observeStopped(id: ActivityId): void {
    if (!this.observedStates.delete(String(id))) return
    this.changed()
  }

  private changed(): void {
    this.snapshotDirty = true
    notifySubscribers(this.listeners, 'activity feed')
  }
}
