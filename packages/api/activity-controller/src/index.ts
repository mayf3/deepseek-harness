/**
 * Host Activity Remote owner: the live-activity roster stream and per-activity
 * output observation. A pure read surface over the optional `ctx.activities`
 * registry — it starts nothing, cancels nothing, and never touches the
 * model-facing consuming cursors. Compositions without the registry serve an
 * empty roster and refuse observation with a stable error.
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-activity'
import { ActivityFeed } from './feed.ts'
import { observeActivity } from './observe.ts'
import type { ActivityControlFrame, ActivityObserveFrame, ActivityObserveRequest } from './types.ts'

export type * from './types.ts'

/** Default coalescing window between observation reads, in milliseconds. */
const DEFAULT_FLUSH_MS = 100

/** Default soft byte budget per observation output frame. */
const DEFAULT_MAX_FRAME_BYTES = 64 * 1024

/** Configuration for the Activity Remote owner. */
export interface Config {
  /** Coalescing window after new output before an observation read, in milliseconds (default 100). */
  flushMs?: number
  /** Soft byte budget per observation output frame (default 65536); one larger chunk ships whole. */
  maxFrameBytes?: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Activity read API and Remote namespace owner. */
    activityController: ActivityController
  }
}

/** Host service backing the generated `ctx.remote.activity` namespace. */
export class ActivityController extends TypertRemoteService {
  static inject = ['typert']

  static Config: z<Config> = z.object({
    flushMs: z.number()
      .step(1)
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(DEFAULT_FLUSH_MS),
    maxFrameBytes: z.number()
      .step(1)
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(DEFAULT_MAX_FRAME_BYTES),
  })

  private readonly feed: ActivityFeed
  private readonly flushMs: number
  private readonly maxFrameBytes: number

  /**
   * @param ctx - Host context; the activity registry stays optional.
   * @param config - validated coalescing and framing bounds.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'activityController', { namespace: 'activity' })
    this.flushMs = (config as Required<Config>).flushMs
    this.maxFrameBytes = (config as Required<Config>).maxFrameBytes
    this.feed = new ActivityFeed(ctx)
  }

  /**
   * Stream a complete roster baseline followed by whole-bucket replacements.
   * @param signal - generation cancellation.
   * @returns baseline followed by per-owner roster replacement frames.
   */
  @Remote({ mode: 'stream' })
  control(signal: AbortSignal): AsyncIterable<ActivityControlFrame> {
    return this.feed.follow(signal)
  }

  /**
   * Stream one activity's retained output from an absolute byte offset, then
   * its terminal status once settled and drained. Non-consuming: the
   * model-facing cursors never observe these reads.
   * @param request - target activity and optional resume offset.
   * @param signal - generation cancellation.
   * @returns anchor, coalesced output frames, and the terminal status.
   */
  @Remote({ mode: 'stream' })
  observe(request: ActivityObserveRequest, signal: AbortSignal): AsyncIterable<ActivityObserveFrame> {
    const registry = this.ctx.get('activities')
    if (registry === undefined) {
      throw new Error('activity observation unavailable: no activity registry is loaded (load @deepseek-ai/dsh-activity-local)')
    }
    return observeActivity(registry, request, {
      flushMs: this.flushMs,
      maxFrameBytes: this.maxFrameBytes,
      ownerOf: id => this.feed.ownerOf(id),
    }, signal)
  }
}

export default ActivityController
