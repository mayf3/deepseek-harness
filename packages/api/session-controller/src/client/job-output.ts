/**
 * React-free client job-record observation: per-job accumulated output views
 * over the `session.observeJob` stream, reference-counted per job so
 * overlapping panels share one stream. The roster itself rides the session
 * control stream (`jobsBySession`); this module carries only the output.
 * @module @deepseek-ai/dsh-api-session-controller/client/job-output
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { RemoteStreamCarrierError, type ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import type { JobId } from '@deepseek-ai/dsh-jobs/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionJob, SessionObserveJobFrame } from '../types.ts'
import type { SessionRemote } from './transport.ts'

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
  readonly status: SessionJob['status']
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

/** Mutable observation bookkeeping behind one {@link ObservedJob} view. */
interface ObservedState {
  view: ObservedJob
  /** Resume offset for the next generation's `from`. */
  cursor: number | undefined
}

/**
 * Owns per-job observation state. Pure data plus subscriptions — transport
 * wiring stays in the client service, UI stays in slot components.
 */
export class ClientJobOutputModel {
  private readonly observedStates = new Map<string, ObservedState>()
  private readonly listeners = new Set<() => void>()
  private snapshotCache: JobOutputSnapshot = { observed: {} }
  private snapshotDirty = false

  /**
   * Read the identity-stable current snapshot.
   * @returns the cached snapshot, rebuilt only after a change.
   */
  getSnapshot(): JobOutputSnapshot {
    if (this.snapshotDirty) {
      const observed: Record<string, ObservedJob> = {}
      for (const [id, state] of this.observedStates) observed[id] = state.view
      this.snapshotCache = { observed }
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
  observeOpened(id: JobId, frame: Extract<SessionObserveJobFrame, { type: 'opened' }>): void {
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
  observeOutput(id: JobId, frame: Extract<SessionObserveJobFrame, { type: 'output' }>): void {
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
  observeStatus(id: JobId, frame: Extract<SessionObserveJobFrame, { type: 'status' }>): void {
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

/** The job-output client service face. */
export interface IJobOutput {
  /** Per-job observation state. */
  readonly state: JobOutputSource
  /**
   * Start observing one job's live record; reference-counted, so two viewers
   * of the same job share one stream.
   * @param sessionId - owning session used for the fenced read; undefined for an unowned job.
   * @param id - job to observe.
   * @returns stop function releasing this observer's reference.
   */
  observe(sessionId: SessionId | undefined, id: JobId): () => void
}

/** One reference-counted observation stream. */
interface ObservationEntry {
  refs: number
  stopped: boolean
  dispose: () => Promise<void>
}

/** Remote face the observation runner drives. */
type JobObserveRemote = Pick<ClientRemote, '$stream'> & { readonly session: Pick<SessionRemote, 'observeJob'> }

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** React-free client job-record observation control. */
    jobOutput: IJobOutput
  }
}

/** Owns the bare job-output snapshot and per-job observation streams. */
export class ClientJobOutput extends Service implements IJobOutput {
  readonly state: JobOutputSource
  private readonly entries = new Map<string, ObservationEntry>()

  /**
   * @param ctx - client root Context.
   * @param remote - generated session namespace plus the Gateway stream factory.
   * @param model - shared client job-output model.
   */
  constructor(
    ctx: Context,
    private readonly remote: JobObserveRemote,
    private readonly model: ClientJobOutputModel,
  ) {
    super(ctx, 'jobOutput')
    this.state = model
    ctx.effect(() => () => {
      const open = [...this.entries.values()]
      this.entries.clear()
      for (const entry of open) {
        entry.stopped = true
        void entry.dispose()
      }
    }, 'session-controller.client.observations')
  }

  observe(sessionId: SessionId | undefined, id: JobId): () => void {
    const key = String(id)
    const existing = this.entries.get(key)
    if (existing !== undefined && !existing.stopped) {
      existing.refs += 1
      return this.releaser(key, existing)
    }
    const entry = this.startObservation(sessionId, id)
    this.entries.set(key, entry)
    return this.releaser(key, entry)
  }

  /**
   * Release closures bind the exact entry they were minted for, never the
   * map's current occupant: a later `observe()` on the same id may have
   * replaced a stopped entry, and decrementing or disposing through the key
   * alone would tear down that newer stream's references.
   */
  private releaser(key: string, entry: ObservationEntry): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      entry.refs -= 1
      if (entry.refs > 0) return
      if (this.entries.get(key) === entry) this.entries.delete(key)
      entry.stopped = true
      void entry.dispose().then(() => {
        // Clear the view only while no successor observation holds the key:
        // a re-expand inside the dispose round-trip already re-anchored the
        // model, and a stale clear would blank its panel for good.
        if (this.entries.has(key)) return
        // The key is the stringified branded id this releaser was minted for.
        this.model.observeStopped(key as JobId)
      })
    }
  }

  private startObservation(sessionId: SessionId | undefined, id: JobId): ObservationEntry {
    const name = `job observation ${String(id)}`
    const stream = this.remote.$stream<SessionObserveJobFrame>({
      name,
      open: (signal) => {
        const from = this.model.cursorOf(id)
        return this.remote.session.observeJob(
          {
            jobId: id,
            ...sessionId !== undefined ? { sessionId } : {},
            ...from !== undefined ? { from } : {},
          },
          signal,
        )
      },
      // A premature end after the anchor is retryable (a Host reload closes the
      // generation); resuming from the cursor loses nothing. An end before the
      // anchor is terminal.
      ended: accepted => accepted
        ? new RemoteStreamCarrierError(`${name} ended before settlement`)
        : new Error(`${name} ended before its anchor`),
    })
    const entry: ObservationEntry = {
      refs: 1,
      stopped: false,
      dispose: () => stream.dispose(),
    }
    void (async () => {
      try {
        for await (const item of stream) {
          const frame = item.value
          if (frame.type === 'opened') {
            this.model.observeOpened(id, frame)
            item.accept()
            continue
          }
          if (frame.type === 'output') {
            this.model.observeOutput(id, frame)
            continue
          }
          // Terminal status: leave the loop before the generation end is
          // classified, then close the stream for good.
          this.model.observeStatus(id, frame)
          break
        }
      } catch (error) {
        if (!entry.stopped) this.model.observeFailed(id, error)
      } finally {
        entry.stopped = true
        void entry.dispose()
      }
    })()
    return entry
  }
}
