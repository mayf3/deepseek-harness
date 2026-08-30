/**
 * Pure types of the turn-outline domain: the ONE home of the `turnOutline`
 * projection-key declaration, free of this package's host-side value imports
 * (zod, the projection definition). Host consumers import `./types`; client
 * aggregates import `./client`, which re-exports this module.
 *
 * @module @deepseek-ai/dsh-session-turn-outline/types
 */

export {}

/** One started turn's outline facts, independent of what a client has paged in. */
export interface TurnOutlineEntry {
  /** Host-assigned turn number (the `turn/start` payload). */
  readonly turn: number
  /** The turn's `turn/start` event seq — paging a window back through this seq loads the whole turn. */
  readonly seq: number
  /** Bounded preview of the turn's first human prompt; `''` until an eligible prompt lands. */
  readonly prompt: string
}

/** Whole-log turn outline: every started turn, strictly increasing by `turn`. */
export interface TurnOutlineProjection {
  /** Started turns in ascending turn order. */
  readonly turns: readonly TurnOutlineEntry[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Whole-log turn outline fold state (identical to the wire view). */
    turnOutline: TurnOutlineProjection
  }
  interface SessionProjectionMap {
    /** Every started turn with its `turn/start` seq and bounded prompt preview; see {@link TurnOutlineProjection}. */
    turnOutline: TurnOutlineProjection
  }
}
