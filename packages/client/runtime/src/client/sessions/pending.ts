// PendingWait: the render-facing half of one Session Controller interaction.

import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  SessionApprovalRequest,
  SessionInteractionId,
  SessionInteractionResult,
  SessionQuestionRequest,
  SessionRespondReceipt,
  SessionRespondRequest,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

/** Kind-keyed payload map: the requested frame's domain fields (envelope fields stripped). */
export interface PendingPayloads {
  approval: Omit<SessionApprovalRequest, 'interactionId' | 'sessionId'>
  question: Omit<SessionQuestionRequest, 'interactionId' | 'sessionId'>
}

/** Pending-interaction discriminant (the keys of PendingPayloads). */
export type PendingKind = keyof PendingPayloads

/** Session-list summary of the user action currently blocking progress. */
export type PendingInteractionStatus = 'approval' | 'plan-review' | 'question'

/** Kind-discriminated union of concrete waits: narrowing on `kind` types `payload`. */
export type PendingInteraction = { [K in PendingKind]: PendingWait<K> }[PendingKind]

/** Key prefixes, one per kind (the key doubles as the Session pending-map key). */
const KEY_PREFIX: Record<PendingKind, string> = { approval: 'a', question: 'q' }

/**
 * One pending host-owned interaction wait: an immutable render face
 * (kind/key/sessionId/payload) plus the response carrier. respond() addresses
 * the Host's opaque interaction identity. Settlement is expressed only by pending-list
 * membership (the settled flag is a fail-loud guard, not a render input).
 */
export class PendingWait<K extends PendingKind = PendingKind> {
  /** Interaction kind (union discriminant). */
  readonly kind: K
  /** Opaque render identity, stable across baseline replay and usable as a React key. */
  readonly key: string
  /** Owning session. */
  readonly sessionId: SessionId
  /** The requested frame's domain fields, verbatim. */
  readonly payload: PendingPayloads[K]
  #settled = false
  readonly #interactionId: SessionInteractionId
  readonly #respond: (request: SessionRespondRequest) => Promise<RemoteResult<SessionRespondReceipt>>

  /**
   * Minted by Session on a requested frame (public construction is the test-fixture path).
   * @param kind - interaction kind.
   * @param interactionId - the Host-minted stable interaction identity.
   * @param sessionId - owning session.
   * @param payload - the requested frame's domain fields.
   * @param respond - Session Controller response method.
   */
  constructor(
    kind: K, interactionId: SessionInteractionId, sessionId: SessionId, payload: PendingPayloads[K],
    respond: (request: SessionRespondRequest) => Promise<RemoteResult<SessionRespondReceipt>>,
  ) {
    this.kind = kind
    this.key = `${KEY_PREFIX[kind]}:${interactionId}`
    this.sessionId = sessionId
    this.payload = payload
    this.#interactionId = interactionId
    this.#respond = respond
  }

  /**
   * Send a result for this wait. Throws synchronously once settled and rejects
   * when the generated Remote call itself fails.
   * @param result - the result shell (ok value / error envelope), domain-encoded by the caller.
   * @returns the carrier receipt.
   */
  respond(result: SessionInteractionResult): Promise<SessionRespondReceipt> {
    if (this.#settled) throw new Error(`pending wait ${this.key} is already settled`)
    return this.send(result)
  }

  private async send(result: SessionInteractionResult): Promise<SessionRespondReceipt> {
    const response = await this.#respond({ interactionId: this.#interactionId, result })
    if (!response.ok) {
      throw new Error(`session interaction response failed: ${response.error.code}: ${response.error.message}`)
    }
    return response.value
  }

  /** Session-only settlement mark (the authoritative resolved frame arrived); respond() throws afterwards. */
  markSettled(): void {
    this.#settled = true
  }
}
