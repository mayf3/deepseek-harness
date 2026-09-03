/**
 * GoalBar's injected face. The target 'conversation.input.dock' slot is
 * declared (children table) and typed by ui-conversation; this package only
 * contributes the entry, so no SlotMap merge lives here. The durable goal
 * value arrives through `useProjection('goal')` (the framework standard kit);
 * the injected face carries process-local activation plus the mutation verbs.
 */

import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { GoalActivationChanged, GoalView } from '@deepseek-ai/dsh-goal/client'

/**
 * The one failure the strip reports without a wire call: the session projects
 * no goal, so no CAS ref exists to address a mutation to.
 */
export interface GoalLocalFailure {
  readonly ok: false
  readonly error: { readonly code: 'no-current-goal'; readonly message: string }
}

/**
 * Settled outcome of one goal mutation, rendered inline by the strip. The
 * strip renders the failure only — the mutated goal arrives through the
 * projection — so the success value stays unread here.
 */
export type GoalActionResult = RemoteResult<unknown> | GoalLocalFailure

/** Remote read face for the goal's process-local activation. */
export interface GoalBarData {
  /**
   * Read the current live goal view at call time.
   * @returns the whole Goal view, or `undefined` before the first create and
   * after a clear tombstone.
   */
  getGoal: () => Promise<RemoteResult<GoalView | undefined>>
  /**
   * Subscribe to process-local activation edges for the session.
   * @param listener - receives the exact live goal activation, or `undefined`
   * when no goal is current.
   * @returns disposer owned by the caller's component lifetime.
   */
  subscribeActivation: (listener: (goal: GoalActivationChanged['goal']) => void) => () => void
}

/** Injected business face of the GoalBar dock entry: the mutation verbs (function properties: the strip destructures them freely). */
export interface GoalBarActions {
  /**
   * Replace the current goal's objective (CAS on the projected ref).
   * @param objective - replacement objective text.
   */
  onEdit: (objective: string) => Promise<GoalActionResult>
  /** Pause an active goal. */
  onPause: () => Promise<GoalActionResult>
  /** Resume a paused goal. */
  onResume: () => Promise<GoalActionResult>
  /** Clear the current goal (tombstone). */
  onClear: () => Promise<GoalActionResult>
}

/** Injected business face of the GoalBar dock entry. */
export type GoalBarInjected = GoalBarActions & GoalBarData
