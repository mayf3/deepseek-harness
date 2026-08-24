/** Browser-safe roster and observation vocabulary for the Activity Remote. */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ActivityId } from '@deepseek-ai/dsh-activity/brand'
import type { JobId } from '@deepseek-ai/dsh-jobs/brand'
import type { CallId } from '@deepseek-ai/dsh-llm/brand'

export type { ActivityId } from '@deepseek-ai/dsh-activity/brand'

/** Lifecycle state carried on the wire; mirrors the registry's status union. */
export type ActivityRowStatus = 'running' | 'completed' | 'failed' | 'killed'

/** Links one roster row to the tool call and background job for the same work. */
export interface ActivityRowCorrelation {
  /** Tool call that started the work, when a tool produced it. */
  readonly callId?: CallId
  /** Background job carrying the model-facing control surface, when one exists. */
  readonly jobId?: JobId
}

/**
 * Browser-safe activity row. `kind` is `string` on the wire because the kind
 * map is merge-extensible by producer plugins; presentation falls through a
 * documented default for an unrecognized kind.
 */
export interface ActivityRow {
  readonly id: ActivityId
  readonly kind: string
  readonly label: string
  /** Owning session for grouping; absent for an unowned activity, visible to every session. */
  readonly sessionId?: SessionId
  readonly correlation?: ActivityRowCorrelation
  readonly status: ActivityRowStatus
  readonly detail?: string
  readonly startedAt: number
  readonly finishedAt?: number
  /** Total UTF-8 bytes the activity has produced so far. */
  readonly outputTotal: number
}

/**
 * Roster stream frames. Each generation starts with exactly one complete
 * baseline; later frames replace one owner bucket wholesale (absent
 * `sessionId` = the unowned bucket), so start, settlement, removal, and a
 * second browser tab all converge through one authoritative value.
 */
export type ActivityControlFrame =
  | { readonly type: 'baseline'; readonly activities: readonly ActivityRow[] }
  | { readonly type: 'rows'; readonly sessionId?: SessionId; readonly activities: readonly ActivityRow[] }

/** Opens one observation stream over a single activity's retained output. */
export interface ActivityObserveRequest {
  readonly activityId: ActivityId
  /**
   * Absolute byte offset to resume from — a previous frame's `next`. Omitted
   * starts at the oldest retained byte.
   */
  readonly from?: number
}

/** One retained output chunk on the wire. `channel` widens to string like `kind`. */
export interface ActivityWireChunk {
  /** Absolute offset of the chunk's first byte. */
  readonly at: number
  readonly text: string
  readonly channel?: string
  /** Bytes immediately before this chunk were lost at the producer or to retention. */
  readonly gapBefore?: true
}

/**
 * Observation stream frames: one `opened` anchor, then coalesced `output`
 * batches, then — once the activity has settled and its retained output is
 * drained — one terminal `status`, after which the stream closes normally.
 * Status rides the same stream as output so settlement can never race a
 * still-open output channel.
 */
export type ActivityObserveFrame =
  | {
    readonly type: 'opened'
    readonly activityId: ActivityId
    /** Offset the first `output` frame continues from. */
    readonly from: number
    /** Oldest retained byte at open time; `from < earliest` means the head is gone. */
    readonly earliest: number
    /** Total bytes produced at open time. */
    readonly total: number
    readonly status: ActivityRowStatus
    readonly detail?: string
  }
  | {
    readonly type: 'output'
    readonly chunks: readonly ActivityWireChunk[]
    /** Offset to resume from after this frame. */
    readonly next: number
    /** Bytes between the requested offset and `chunks` were already evicted. */
    readonly lossy?: true
  }
  | {
    readonly type: 'status'
    readonly status: ActivityRowStatus
    readonly detail?: string
    readonly finishedAt?: number
  }
