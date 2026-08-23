// PendingWait: the legacy render-facing carrier retained until UI owners consume Remote events directly.

import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

/** One selectable answer offered by the legacy question renderer. */
export interface PendingQuestionOption {
  readonly label: string
  readonly description?: string
}

/** One question rendered by the legacy question composer. */
export interface PendingQuestionItem {
  readonly id: string
  readonly question: string
  readonly detail?: string
  readonly header?: string
  readonly options?: readonly PendingQuestionOption[]
  readonly multiSelect?: boolean
  readonly intent?: { readonly kind: 'plan-review'; readonly approve: string }
}

/** Structured answer returned by the legacy question composer. */
export interface PendingQuestionAnswer {
  answers: {
    id: string
    selected: string[]
    custom?: string
  }[]
}

/** Kind-keyed payload map: the requested frame's domain fields (envelope fields stripped). */
export interface PendingPayloads {
  approval: {
    readonly approvalId: string
    readonly toolName: string
    readonly callId?: string
    readonly reason?: string
  }
  question: { readonly questions: readonly PendingQuestionItem[] }
}

interface PendingResponseValues {
  approval: {
    readonly sessionId: SessionId
    readonly approvalId: string
    readonly outcome: 'allowed-once' | 'rejected'
  }
  question: { readonly sessionId: SessionId; readonly answer: PendingQuestionAnswer }
}

type PendingInteractionResult<K extends PendingKind> =
  | { readonly ok: true; readonly value: PendingResponseValues[K] }
  | {
    readonly ok: false
    readonly error: { readonly code: string; readonly message: string; readonly details: Readonly<Record<string, unknown>> }
  }

/** Receipt returned by the legacy response carrier. */
export interface PendingRespondReceipt {
  readonly accepted: boolean
  readonly reason?: string
}

interface PendingRespondRequest<K extends PendingKind> {
  readonly interactionId: string
  readonly result: PendingInteractionResult<K>
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
  readonly #interactionId: string
  readonly #respond: (request: PendingRespondRequest<K>) => Promise<RemoteResult<PendingRespondReceipt>>

  /**
   * Minted by Session on a requested frame (public construction is the test-fixture path).
   * @param kind - interaction kind.
   * @param interactionId - the Host-minted stable interaction identity.
   * @param sessionId - owning session.
   * @param payload - the requested frame's domain fields.
   * @param respond - Session Controller response method.
   */
  constructor(
    kind: K, interactionId: string, sessionId: SessionId, payload: PendingPayloads[K],
    respond: (request: PendingRespondRequest<K>) => Promise<RemoteResult<PendingRespondReceipt>>,
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
  respond(result: PendingInteractionResult<K>): Promise<PendingRespondReceipt> {
    if (this.#settled) throw new Error(`pending wait ${this.key} is already settled`)
    return this.send(result)
  }

  private async send(result: PendingInteractionResult<K>): Promise<PendingRespondReceipt> {
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
