/** Reconnect-safe activity roster producer over the optional `ctx.activities` registry. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ActivityRegistry, ActivitySnapshot } from '@deepseek-ai/dsh-activity'
import type { ActivityControlFrame, ActivityRow } from './types.ts'

/**
 * Project one registry snapshot into its browser-safe roster row.
 * @param snapshot - fresh registry snapshot.
 * @returns detached wire row for Remote consumers.
 */
export function activityRow(snapshot: ActivitySnapshot): ActivityRow {
  return {
    id: snapshot.id,
    kind: snapshot.kind,
    label: snapshot.label,
    ...snapshot.ownerSession !== undefined ? { sessionId: snapshot.ownerSession } : {},
    ...snapshot.correlation !== undefined
      ? {
        correlation: {
          ...snapshot.correlation.callId !== undefined ? { callId: snapshot.correlation.callId } : {},
          ...snapshot.correlation.jobId !== undefined ? { jobId: snapshot.correlation.jobId } : {},
        },
      }
      : {},
    status: snapshot.status,
    ...snapshot.detail !== undefined ? { detail: snapshot.detail } : {},
    startedAt: snapshot.startedAt,
    ...snapshot.finishedAt !== undefined ? { finishedAt: snapshot.finishedAt } : {},
    outputTotal: snapshot.outputTotal,
  }
}

/** One owner bucket: the exact live owner used for fenced reads plus its rows. */
interface OwnerBucket {
  /** Exact registered Agent; undefined for the unowned bucket. */
  readonly owner: Agent | undefined
  rows: readonly ActivityRow[]
}

const UNOWNED = ''

/**
 * Owns registry observation, the owner-bucketed roster mirror, and all active
 * control-stream generations. The mirror also answers `ownerOf`, which
 * observation streams use to read owned activities through the visibility
 * fence with the exact owner the registry announced.
 */
export class ActivityFeed {
  private readonly followers = new Set<ActivityFollower>()
  private readonly buckets = new Map<string, OwnerBucket>()
  private readonly registry: ActivityRegistry | undefined

  /** @param ctx - Host context; the activity registry stays optional. */
  constructor(ctx: Context) {
    this.registry = ctx.get('activities')
    if (this.registry === undefined) return
    const registry = this.registry
    this.refresh(undefined)
    for (const agent of ctx.get('agents')?.list() ?? []) this.refresh(agent)
    registry.onActivitiesChanged((owner) => {
      this.refresh(owner)
      const bucket = this.buckets.get(owner?.id ?? UNOWNED)
      this.publish({
        type: 'rows',
        ...owner !== undefined ? { sessionId: owner.id } : {},
        activities: bucket?.rows ?? [],
      })
    })
    ctx.effect(() => () => {
      for (const follower of this.followers) follower.close()
      this.followers.clear()
    }, 'activity-controller.feed')
  }

  /**
   * Read the complete current roster synchronously.
   * @returns every visible row across all owner buckets.
   */
  baseline(): readonly ActivityRow[] {
    return [...this.buckets.values()].flatMap(bucket => bucket.rows)
  }

  /**
   * Resolve the exact owner the registry announced for one activity, for
   * fenced reads. `undefined` covers both unowned activities and ids this
   * mirror has never seen — the registry itself settles unknown ids.
   * @param id - activity id to resolve.
   * @returns the exact live owner, or undefined.
   */
  ownerOf(id: string): Agent | undefined {
    for (const bucket of this.buckets.values()) {
      if (bucket.rows.some(row => String(row.id) === id)) return bucket.owner
    }
    return undefined
  }

  /**
   * Open one generation beginning with a complete baseline.
   * @param signal - generation cancellation.
   * @returns baseline followed by whole-bucket replacement frames.
   */
  async *follow(signal: AbortSignal): AsyncIterable<ActivityControlFrame> {
    signal.throwIfAborted()
    const follower = new ActivityFollower()
    this.followers.add(follower)
    try {
      yield { type: 'baseline', activities: this.baseline() }
      yield* follower.read(signal)
    } finally {
      this.followers.delete(follower)
      follower.close()
    }
  }

  /** Re-read one owner's visible rows into its bucket; an emptied bucket is dropped. */
  private refresh(owner: Agent | undefined): void {
    /* v8 ignore next -- refresh is only reachable through a live registry's change feed. */
    if (this.registry === undefined) return
    const rows = this.registry.list(owner)
      .filter(snapshot => owner === undefined
        ? snapshot.ownerSession === undefined
        : snapshot.ownerSession === owner.id)
      .map(activityRow)
    const key = owner?.id ?? UNOWNED
    if (rows.length === 0) {
      this.buckets.delete(key)
      return
    }
    this.buckets.set(key, { owner, rows })
  }

  private publish(frame: Exclude<ActivityControlFrame, { readonly type: 'baseline' }>): void {
    for (const follower of this.followers) follower.push(frame)
  }
}

/* jscpd:ignore-start -- mirrors WorkspaceFeed's follower fan-out by design; both serve baseline-plus-increment Remote streams. */
class ActivityFollower {
  private readonly frames: ActivityControlFrame[] = []
  private waiting: (() => void) | undefined
  private closed = false

  push(frame: ActivityControlFrame): void {
    /* v8 ignore next -- closed followers are removed before later publication can reach them. */
    if (this.closed) return
    this.frames.push(frame)
    this.waiting?.()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.waiting?.()
  }

  async *read(signal: AbortSignal): AsyncIterable<ActivityControlFrame> {
    while (!this.closed && !signal.aborted) {
      const frame = this.frames.shift()
      if (frame !== undefined) {
        yield frame
        continue
      }
      await this.wait(signal)
    }
  }

  private wait(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        signal.removeEventListener('abort', finish)
        /* v8 ignore next -- one read owns the sole installed wait callback. */
        if (this.waiting === finish) this.waiting = undefined
        resolve()
      }
      this.waiting = finish
      signal.addEventListener('abort', finish, { once: true })
      /* v8 ignore next -- native signals and the private queue cannot change during this synchronous setup. */
      if (signal.aborted || this.closed || this.frames.length > 0) finish()
    })
  }
}
/* jscpd:ignore-end */
