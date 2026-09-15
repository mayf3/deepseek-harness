/** Chat-owned per-Session view state. */

/** Tool call identity as carried by Chat nodes. */
export type ToolCallId = string

/**
 * Manual disclosure override: null records a collapsed live Turn; a Step records
 * an expanded completed answer, with zero reserved for completion without an answer.
 */
export interface TurnProcessViewEntry {
  readonly turn: number
  readonly answerStep: number | null
}

/** Per-Session state shared only by the Chat view and details surface. */
export interface ChatStoreState {
  turnProcesses: TurnProcessViewEntry[]
}
