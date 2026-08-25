/** React-free client activity service: roster snapshot plus observation control. */

import { Service, type Context } from '@deepseek-ai/cordis'
import { RemoteStreamCarrierError, type ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-activity-controller/remote'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type { ActivityId } from '@deepseek-ai/dsh-activity/brand'
import type { ActivityObserveFrame } from '../types.ts'
import type { ActivityFeedSnapshot, ClientActivityModel } from './model.ts'

/** Complete generated `ctx.remote.activity` namespace. */
export type ActivityRemote = TypertClientRemote['activity']

/** Bare observable source for the client activity snapshot. */
export interface ActivityFeedSource {
  /** Read the identity-stable current snapshot. */
  getSnapshot(): ActivityFeedSnapshot
  /**
   * Subscribe to snapshot changes.
   * @param listener - invalidation callback.
   * @returns unsubscribe function.
   */
  subscribe(listener: () => void): () => void
}

/** The activity feed's client service face. */
export interface IActivityFeed {
  /** Roster rows, observation state, and arrival phase. */
  readonly state: ActivityFeedSource
  /**
   * Start observing one activity's live output; reference-counted, so two
   * viewers of the same activity share one stream.
   * @param id - activity to observe.
   * @returns stop function releasing this observer's reference.
   */
  observe(id: ActivityId): () => void
}

/** One reference-counted observation stream. */
interface ObservationEntry {
  refs: number
  stopped: boolean
  dispose: () => Promise<void>
}

/** Remote face the observation runner drives. */
type ActivityStreamRemote = Pick<ClientRemote, '$stream'> & { readonly activity: ActivityRemote }

/** Owns the bare activity snapshot and per-activity observation streams. */
export class ClientActivityFeed extends Service implements IActivityFeed {
  readonly state: ActivityFeedSource
  private readonly entries = new Map<string, ObservationEntry>()

  /**
   * @param ctx - client root Context.
   * @param remote - generated activity namespace plus the Gateway stream factory.
   * @param model - shared client activity model.
   */
  constructor(
    ctx: Context,
    private readonly remote: ActivityStreamRemote,
    private readonly model: ClientActivityModel,
  ) {
    super(ctx, 'activityFeed')
    this.state = model
    ctx.effect(() => () => {
      const open = [...this.entries.values()]
      this.entries.clear()
      for (const entry of open) {
        entry.stopped = true
        void entry.dispose()
      }
    }, 'activity-controller.client.observations')
  }

  observe(id: ActivityId): () => void {
    const key = String(id)
    const existing = this.entries.get(key)
    if (existing !== undefined && !existing.stopped) {
      existing.refs += 1
      return this.releaser(key, existing)
    }
    const entry = this.startObservation(id)
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
        this.model.observeStopped(key as ActivityId)
      })
    }
  }

  private startObservation(id: ActivityId): ObservationEntry {
    const name = `activity observation ${String(id)}`
    const stream = this.remote.$stream<ActivityObserveFrame>({
      name,
      open: (signal) => {
        const from = this.model.cursorOf(id)
        return this.remote.activity.observe(
          { activityId: id, ...from !== undefined ? { from } : {} },
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
