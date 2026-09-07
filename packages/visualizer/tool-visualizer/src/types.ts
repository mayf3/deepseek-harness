/** Host-accepted widget source kind. */
export type WidgetKind = 'svg' | 'html'

/** Widget-authored follow-up submitted for one exact widget. */
export interface WidgetPromptRequest {
  /** Exact persisted `tool/result` event sequence displayed by the Client. */
  readonly resultSeq: number
  readonly text: string
}
