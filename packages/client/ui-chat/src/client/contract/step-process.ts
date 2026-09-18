/** Stable step-group layout and per-group presentation published by Chat. */
import type { ChatNode } from './chat-nodes.ts'

/** One stable renderer seat, optionally restricted to part of an assistant node. */
export interface ProcessSeat {
  readonly nodeKey: string
  readonly assistantPart?: 'reasoning' | 'response'
}

/** A consecutive process range or a standalone transcript row. */
export interface ProcessRange {
  readonly key: string
  readonly seats: readonly [ProcessSeat, ...ProcessSeat[]]
  readonly process: boolean
  readonly closed: boolean
  readonly turn: number | undefined
}

/** Tool categories used by abstract process titles. */
export type ProcessActivity = 'read' | 'search' | 'edit' | 'commands' | 'code'
  | 'webSearch' | 'webFetch' | 'subagents' | 'plan' | 'questions' | 'tools'

/** Ranked tool categories and live detail for one consecutive process range. */
export interface ProcessActivitySummary {
  readonly counts: readonly { readonly kind: ProcessActivity; readonly count: number }[]
  readonly running: ProcessActivity | undefined
  readonly runningDetail: string
}

/** Layout changes only when renderer seats or their grouping change. */
export type StepProcessLayout = Omit<ProcessRange, 'closed'>

/** Current content and status for one stable group key. */
export interface StepProcessGroup {
  readonly range: ProcessRange
  readonly nodes: readonly ChatNode[]
  readonly summary: ProcessActivitySummary
}

/** Footer facts computed from the visible Turn contents. */
export interface TurnFooterPresentation {
  readonly hasLaterChatNode: boolean
  readonly endsWithResponse: boolean
}

/** Data-layer process projection; content updates preserve unrelated groups. */
export interface ChatStepProcessIndex {
  /** Ordered renderer seats; unchanged during content-only streaming. */
  readonly layout: readonly StepProcessLayout[]
  /**
   * @param key - stable group key.
   * @returns current group content, or absence after regrouping.
   */
  get(key: string): StepProcessGroup | undefined
  /**
   * @param turn - owning Turn.
   * @returns footer facts, or absence without a footer.
   */
  footer(turn: number): TurnFooterPresentation | undefined
}
