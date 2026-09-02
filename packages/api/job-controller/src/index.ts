/**
 * Host job Remote owner: streams one background job's observation record to
 * browsers over the generated `job` namespace. The roster itself rides the
 * session control stream (`jobsBySession`, owned by `dsh-api-session-controller`);
 * this controller carries only the non-consuming record output.
 * @module @deepseek-ai/dsh-api-job-controller
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-jobs'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { observeJobRecord } from './observe.ts'
import type { JobObserveFrame, JobObserveRequest } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host job Remote namespace owner. */
    jobController: JobController
  }
}

/** Default coalescing window between record reads, in milliseconds. */
const DEFAULT_OBSERVE_FLUSH_MS = 100

/** Default soft byte budget per output frame. */
const DEFAULT_OBSERVE_MAX_FRAME_BYTES = 64 * 1024

/** Job Controller deployment policy. */
export interface Config {
  /** Coalescing window after new record output before an observation read, in milliseconds (default 100). */
  readonly observeFlushMs?: number
  /** Soft byte budget per observation output frame (default 65536); one larger chunk ships whole. */
  readonly observeMaxFrameBytes?: number
}

/** Host service backing the generated `ctx.remote.job` namespace. */
export class JobController extends TypertRemoteService {
  static inject = ['agents', 'jobs', 'typert']

  static Config: z<Config> = z.object({
    observeFlushMs: z.natural().min(1).default(DEFAULT_OBSERVE_FLUSH_MS),
    observeMaxFrameBytes: z.natural().min(1).default(DEFAULT_OBSERVE_MAX_FRAME_BYTES),
  })

  private readonly observeFlushMs: number
  private readonly observeMaxFrameBytes: number

  /**
   * @param ctx - Host context carrying the live Agent registry and the job registry.
   * @param config - observation cadence and framing policy.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'jobController', { namespace: 'job' })
    // schemastery (the exported Config schema) has already filled the defaulted
    // fields; the assertion records that resolution, not a hidden fallback.
    const resolved = config as Required<Config>
    this.observeFlushMs = resolved.observeFlushMs
    this.observeMaxFrameBytes = resolved.observeMaxFrameBytes
  }

  /**
   * Stream one job's retained record output from an absolute byte offset,
   * then its terminal status once settled and drained. Non-consuming: the
   * model-facing cursor and notice state never observe these reads. The
   * request's session resolves the fenced-read caller; the registry rejects a
   * job the session does not own, a job without a record, or an unknown job.
   * @param request - target job, owning session, and optional resume offset.
   * @param signal - cancellation owned by the Remote stream carrier.
   * @returns anchor, coalesced output frames, and the terminal status.
   */
  @Remote({ mode: 'stream' })
  observe(request: JobObserveRequest, signal: AbortSignal): AsyncIterable<JobObserveFrame> {
    const caller = request.sessionId === undefined ? undefined : this.ctx.agents.get(request.sessionId)
    return observeJobRecord(this.ctx.jobs, request, {
      flushMs: this.observeFlushMs,
      maxFrameBytes: this.observeMaxFrameBytes,
      caller,
    }, signal)
  }
}

export default JobController
