/** Session-owned observable state excluding Conversation target data. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type { ClientFailure } from './result.ts'

/** History-open lifecycle of a Session event window. */
export type OpenState = 'cold' | 'loading' | 'open' | 'error'

/** Send/stop failure surfaced by Session consumers. */
export interface PromptError {
  readonly op: 'send' | 'stop'
  readonly error: ClientFailure
}

/** Immutable Session lifecycle and control snapshot. */
export interface SessionSnapshot {
  readonly sessionId: SessionId
  readonly running: boolean
  readonly subagent: {
    readonly address: SubagentAddress
    /** Absent until the direct-parent catalog resolves. */
    readonly parentAvailable?: boolean
  } | null
  readonly removed: boolean
  readonly openState: OpenState
  readonly openError: ClientFailure | null
  readonly hasMore: boolean
  readonly loadingOlder: boolean
  readonly promptError: PromptError | null
  readonly blank: boolean
  readonly lastAgentError: string | null
  /** A prompt call has begun on this Client Session object. */
  readonly promptAttempted: boolean
  /** The first accepted prompt has not reached a durable `turn/start` event. */
  readonly awaitingFirstTurn: boolean
}
