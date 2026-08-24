/**
 * The streaming-output observation Service Definition (`ctx.activities`). An
 * activity is one observable unit of long-running work: an append-only bounded
 * output stream plus live status, readable by any number of independent
 * observers at absolute byte offsets. The registry is a pure observation
 * plane — it starts nothing, cancels nothing, and is invisible to the model;
 * producers keep their execution resources and their existing model-facing
 * surfaces (`ctx.jobs` cursors, tool results). The process-local registry
 * lives in `@deepseek-ai/dsh-activity-local`.
 * @module @deepseek-ai/dsh-activity
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  ActivitiesChangedListener, ActivityHandle, ActivityId, ActivityOpen, ActivityOutputListener,
  ActivityRead, ActivitySnapshot,
} from './types.ts'

export { ActivityId } from './brand.ts'
export type {
  ActivityAppendOptions,
  ActivityChannel,
  ActivityCorrelation,
  ActivitiesChangedListener,
  ActivityHandle,
  ActivityKind,
  ActivityKindMap,
  ActivityOpen,
  ActivityOutcome,
  ActivityOutputChunk,
  ActivityOutputListener,
  ActivityRead,
  ActivitySnapshot,
  ActivityStatus,
} from './types.ts'
export { pumpActivityOutput } from './pump.ts'
export type { ActivityPumpOptions, ActivityPumpRead, ActivityPumpSource } from './pump.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    activities: ActivityRegistry
  }
}

/**
 * Abstract streaming-output registry. Subclass, implement the abstract
 * methods, and load the subclass as a plugin — it registers as
 * `ctx.activities` (one implementation per context; loading a second throws,
 * which is cordis' standard duplicate-service behavior).
 *
 * Implementations must honor these semantics:
 * - Observation never consumes. Any number of readers hold their own absolute
 *   byte offsets; a read changes no cursor and no producer state, so the
 *   model-facing paths (`ctx.jobs.read()`, tool results) are unaffected.
 * - Records outlive producer fibers. Owner disposal ends still-open records
 *   and removes them; service disposal ends and clears everything. Neither
 *   awaits a producer — the registry owns no execution resource.
 * - Retention is bounded. Appends past the live cap drop the oldest retained
 *   bytes; a reader below the retained window gets a lossy read, never an
 *   error. Settlement trims retention to the settled cap.
 * - Listener delivery is owner-relative: a listener registered from an
 *   unscoped context — a host composition's own carrier — sees every owner,
 *   while one registered under an agent composition's scope sees exactly the
 *   agents composed under it. Every listener is contained.
 */
export abstract class ActivityRegistry extends Service {
  constructor(ctx: Context) {
    // `abstract` erases at runtime, so a composition row naming this package
    // would register a ctx.activities with no method implementations and fail
    // far from the misconfiguration. Fail loud at load instead.
    if (new.target === ActivityRegistry) {
      throw new Error('@deepseek-ai/dsh-activity is the abstract activity observation seam; load an implementation such as @deepseek-ai/dsh-activity-local instead')
    }
    super(ctx, 'activities')
  }

  /**
   * Validate the spec, attach owner cleanup, and atomically register one
   * activity. A rejection leaves no id; after return the producer owns the
   * handle and the visible set has changed.
   * @param spec - activity identity, owner, and correlation.
   * @returns the producer face of the registered activity.
   */
  abstract open(spec: ActivityOpen): ActivityHandle

  /**
   * List caller-owned and unowned activities in registration order without
   * exposing another session's labels or output.
   * @param caller - reading agent; a non-agent caller sees only unowned activities.
   * @returns fresh snapshots.
   */
  abstract list(caller?: Agent): ActivitySnapshot[]

  /**
   * Return a fresh snapshot. Throws for an unknown or foreign activity.
   * @param id - activity to look up.
   * @param caller - reading agent checked against the owner.
   * @returns a fresh snapshot.
   */
  abstract get(id: ActivityId, caller?: Agent): ActivitySnapshot

  /**
   * Read retained output from an absolute byte offset without consuming it.
   * Resume by passing a previous read's `next`; a foreign offset inside a
   * retained chunk returns that whole chunk (its `at` may precede `from`).
   * Throws for an unknown or foreign activity or a negative or non-integer
   * offset.
   * @param id - activity to read.
   * @param from - absolute byte offset to read from (0 for the retained head).
   * @param caller - reading agent checked against the owner.
   * @returns retained chunks overlapping `[from, total)`, the resume offset, and the lossy flag.
   */
  abstract read(id: ActivityId, from: number, caller?: Agent): ActivityRead

  /**
   * Register an effect-scoped observer of visible-set changes: opening,
   * detail updates, settlement, owner-disposal removal, and the emptying that
   * service disposal commits — so an observer re-reads rather than
   * accumulating deltas. Listeners are contained and never awaited.
   * @param listener - receives the owner whose visible set changed, or
   *   `undefined` when an unowned activity changed and every caller's set did.
   * @returns disposer that unregisters the listener.
   */
  abstract onActivitiesChanged(listener: ActivitiesChangedListener): () => void

  /**
   * Register an effect-scoped observer of stream advancement — one signal per
   * committed append and one at settlement, carrying only the activity id.
   * A consumer schedules a {@link read} from its own cursor; the registry
   * never pushes payloads. Listeners are contained and never awaited.
   * @param listener - receives the id whose stream advanced.
   * @returns disposer that unregisters the listener.
   */
  abstract onOutput(listener: ActivityOutputListener): () => void
}

export default ActivityRegistry
