/** Deployment-varying limits for the Visualizer extension. */
export interface Config {
  /** Maximum UTF-8 bytes accepted for one widget source argument. At most 131072. */
  maxWidgetBytes?: number
  /** Maximum UTF-8 bytes accepted for one complete labelled widget follow-up. At most 4096. */
  maxPromptBytes?: number
  /** Per-Agent widget follow-ups admitted during one rolling minute. Defaults to 4. */
  maxPromptsPerMinutePerAgent?: number
}

/** Progressive visual guidance categories exposed to the model. */
export type WidgetGuidelineModule = 'diagram' | 'mockup' | 'interactive' | 'chart' | 'illustration'

/** Host-accepted widget source kind. */
export type WidgetKind = 'svg' | 'html'

/** Widget-authored follow-up submitted for one exact widget. */
export interface WidgetPromptRequest {
  /** Exact persisted `tool/result` event sequence displayed by the Client. */
  readonly resultSeq: number
  readonly text: string
}

/** Host acknowledgement after a widget-authored prompt enters the Agent inbox. */
export interface WidgetPromptResult {
  readonly queued: true
}
