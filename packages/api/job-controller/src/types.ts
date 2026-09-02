/**
 * Wire types of the generated `job` Remote namespace: the observation request
 * and the frames its stream yields. Client-safe: no Host imports.
 * @module @deepseek-ai/dsh-api-job-controller/types
 */

import type { JobId } from '@deepseek-ai/dsh-jobs/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * A job's lifecycle state on the wire. Spelled out rather than imported from
 * the registry package so this client-safe face pulls no Host declaration
 * merges into browser programs; it is the registry's `JobStatus` union.
 */
export type JobObserveStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed'

/** Target of one `job.observe` stream: the job, its owning session, and an optional resume offset. */
export interface JobObserveRequest {
  /**
   * Owning session, resolved to the live agent for the fenced record read.
   * Omitted for an unowned job, which any caller may observe.
   */
  readonly sessionId?: SessionId
  readonly jobId: JobId
  /**
   * Absolute byte offset to resume from (a prior frame's `next`). Omitted, the
   * stream starts at the oldest retained byte.
   */
  readonly from?: number
}

/** Human-initiated cancellation of one background job visible to a session. */
export interface JobKillRequest {
  /** Session whose task list carries the job; resolves the live agent for the fenced lookup. */
  readonly sessionId: SessionId
  readonly jobId: JobId
}

/** Receipt after the registry accepted the human kill request. */
export interface JobKillValue {
  readonly outcome: 'requested' | 'already-finished'
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The session's task list no longer carries a killable row under that id. */
    'job/not-found': { readonly sessionId: SessionId; readonly jobId: JobId }
  }
}

/** One retained record chunk on the wire. `channel` widens to string like a job's `kind`. */
export interface JobWireChunk {
  /** Absolute offset of the chunk's first byte. */
  readonly at: number
  readonly text: string
  readonly channel?: string
  /** Bytes immediately before this chunk were lost at the producer or to retention. */
  readonly gapBefore?: true
}

/**
 * Job observation stream frames: one `opened` anchor, then coalesced `output`
 * batches, then — once the job has settled and its retained record is
 * drained — one terminal `status`, after which the stream closes normally.
 * Status rides the same stream as output so settlement can never race a
 * still-open output channel.
 */
export type JobObserveFrame =
  | {
    readonly type: 'opened'
    readonly jobId: JobId
    /** Offset the first `output` frame continues from. */
    readonly from: number
    /** Oldest retained byte at open time; `from < earliest` means the head is gone. */
    readonly earliest: number
    /** Total bytes produced at open time. */
    readonly total: number
    readonly status: JobObserveStatus
    readonly detail?: string
  }
  | {
    readonly type: 'output'
    readonly chunks: readonly JobWireChunk[]
    /** Offset to resume from after this frame. */
    readonly next: number
    /** Bytes between the requested offset and `chunks` were already evicted. */
    readonly lossy?: true
  }
  | {
    readonly type: 'status'
    readonly status: JobObserveStatus
    readonly detail?: string
    readonly finishedAt?: number
  }
