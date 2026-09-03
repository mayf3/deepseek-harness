/**
 * The `ctx.jobOutput` client service: reference-counted per-job observation
 * streams over `job.observe`, so overlapping viewers of one job share one
 * stream and resume from the model's cursor across reconnects, plus the
 * human kill passthrough over `job.kill`.
 * @module @deepseek-ai/dsh-api-job-controller/client/service
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { RemoteStreamCarrierError, type ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { JobId } from '@deepseek-ai/dsh-jobs/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { JobKillRequest, JobKillValue, JobObserveFrame, JobObserveRequest } from '../types.ts'
import type { ClientJobOutputModel, JobOutputSource } from './model.ts'

/** The generated `job` namespace face the observation runner drives. */
export interface JobRemote {
  /**
   * Open one observation generation.
   * @param request - target job, owning session, and optional resume offset.
   * @param signal - generation cancellation.
   * @returns the frame sequence of one generation.
   */
  observe(request: JobObserveRequest, signal?: AbortSignal): AsyncIterable<JobObserveFrame>
  /**
   * Kill one job on the human's behalf.
   * @param request - the session whose list carries the job, and the job id.
   * @returns the registry's admission, or the business/transport failure.
   */
  kill(request: JobKillRequest): Promise<RemoteResult<JobKillValue>>
}

/** Remote faces the observation runner drives: the Gateway stream factory and the `job` namespace. */
export interface JobObserveRemote {
  readonly $stream: ClientRemote['$stream']
  readonly job: JobRemote
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
  /**
   * Kill one background job from a session's task list. Pure RPC passthrough:
   * row state converges through the jobs control frames, and the caller (the
   * task-list control) owns error presentation.
   * @param sessionId - session whose task list carries the job.
   * @param id - the job row's registry id.
   * @returns the registry's admission, or the business/transport failure.
   */
  kill(sessionId: SessionId, id: JobId): Promise<RemoteResult<JobKillValue>>
}

/** One reference-counted observation stream. */
interface ObservationEntry {
  refs: number
  stopped: boolean
  dispose: () => Promise<void>
}

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
   * @param remote - the Gateway stream factory plus the generated `job` namespace, both resolved by the caller.
   * @param model - shared client job-output model.
   */
  constructor(
    ctx: Context,
    private readonly remote: JobObserveRemote,
    private readonly model: ClientJobOutputModel,
  ) {
    super(ctx, 'jobOutput')
    this.state = model
    ctx.effect(() => async () => {
      const open = [...this.entries.values()]
      this.entries.clear()
      for (const entry of open) entry.stopped = true
      // Cordis awaits an async disposer, so the fiber stays unloading until
      // every carrier iterator has closed and a successor plugin instance
      // cannot overlap one. A carrier whose teardown fails is stopped all the
      // same; its failure has no consumer here.
      await Promise.allSettled(open.map(entry => entry.dispose()))
    }, 'job-controller.client.observations')
  }

  kill(sessionId: SessionId, id: JobId): Promise<RemoteResult<JobKillValue>> {
    return this.remote.job.kill({ sessionId, jobId: id })
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
    const stream = this.remote.$stream<JobObserveFrame>({
      name,
      open: (signal) => {
        const from = this.model.cursorOf(id)
        return this.remote.job.observe(
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
