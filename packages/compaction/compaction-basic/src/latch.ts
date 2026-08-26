/**
 * Deterministic failure latch for automatic compaction.
 *
 * A deterministic failure is locally reproducible under an unchanged
 * operational key. Automatic compaction may confirm it at most once (so at
 * most two provider calls end in deterministic failure per unchanged key),
 * then latches: further automatic attempts under the same key make zero
 * summarization provider calls while continuing to report the held cause.
 * Transient failures never latch.
 *
 * @module @deepseek-ai/dsh-compaction-basic/latch
 */

import { CONTEXT_WINDOW_EXCEEDED_CODE, deepFreeze, isContextWindowExceededError } from '@deepseek-ai/dsh-llm'
import type { CapacityTarget } from './capacity.ts'

/** Locally reproducible failure classes that can open the latch. */
export type DeterministicFailureClass =
  | 'admission-impossible'
  | 'no-balanced-eligible-span'
  | 'pass-bound-exceeded'
  | 'no-progress'
  | 'summary-not-smaller'
  | 'provider-context-window-exceeded'
  | 'request-size-invalid-request'

/** Classified outcome of one compaction failure. */
export type FailureClassification =
  | { readonly kind: 'deterministic'; readonly failureClass: DeterministicFailureClass }
  | { readonly kind: 'transient' }

/** Bumped when pass-policy semantics change so held keys from older revisions stop matching. */
export const PASS_POLICY_REVISION = 1

/** Operational state a deterministic failure is reproducible under. */
export interface CompactionLatchBasis {
  /** Session surface generation; any committed replacement changes it. */
  readonly replaceGeneration: number
  /** Conversation route the policy was resolved for. */
  readonly conversation: CapacityTarget
  /** Exact summarization route admission priced. */
  readonly summarization: CapacityTarget
  /** Identity of the resolved capacity snapshot backing the budget. */
  readonly capacityIdentity: string
  /** Actual summarization `maxTokens` reserved out of the budget. */
  readonly effectiveOutputReserve: number
  /** Resolved extra admission reserve against estimator drift. */
  readonly tokenizerSafetyMargin: number
  /** Governing pass bound and retention budget. */
  readonly passPolicy: { readonly maxPasses: number; readonly retainTokens: number }
  /** Semantics revision of `passPolicy`. */
  readonly passPolicyRevision: number
}

/** A recorded deterministic failure: the basis plus its classification. */
export interface CompactionLatchKey extends CompactionLatchBasis {
  readonly failureClass: DeterministicFailureClass
}

/** One session's latch state; `undefined` while nothing deterministic is held. */
export interface LatchRecord {
  readonly key: CompactionLatchKey
  /** Held diagnostic reported while the latch is active. */
  readonly cause: string
  /** Deterministic failures confirmed under exactly this key. */
  readonly deterministicFailures: number
  /** Whether automatic compaction is suppressed under this key. */
  latched: boolean
}

/** Provider request-size wording that ties `INVALID_REQUEST` to request size. */
const REQUEST_SIZE_WORDING = /\b413\b|payload too large|request body too large|length limit exceeded/i

/**
 * Classify one compaction failure. `TRANSPORT`, `SERVER`, `TIMEOUT`,
 * `ABORTED`, rate or quota failures, `terminated`, `fetch failed`, an
 * incomplete stream, and every unclassified provider failure are transient;
 * only the frozen deterministic classes can latch. Wrappers such as
 * `ManualCompactionError` carry the original failure in `cause`, so the
 * classification follows a bounded cause chain.
 * @param error - failure thrown by admission, pass control, or the summarizer.
 * @returns the deterministic class, or `transient`.
 */
export function classifyFailure(error: unknown): FailureClassification {
  let current: unknown = error
  for (let depth = 0; depth < 3 && current !== undefined; depth += 1) {
    if (current instanceof DeterministicCompactionError) {
      return { kind: 'deterministic', failureClass: current.failureClass }
    }
    const code = errorCode(current)
    if (code === CONTEXT_WINDOW_EXCEEDED_CODE || isContextWindowExceededError(errorText(current))) {
      return { kind: 'deterministic', failureClass: 'provider-context-window-exceeded' }
    }
    if (code === 'INVALID_REQUEST' && REQUEST_SIZE_WORDING.test(errorText(current))) {
      return { kind: 'deterministic', failureClass: 'request-size-invalid-request' }
    }
    current = (current as { cause?: unknown }).cause
  }
  return { kind: 'transient' }
}

/**
 * Structural equality of two latch bases; classification is matched separately.
 * @param left - one basis to compare.
 * @param right - the other basis to compare.
 * @returns true when every basis component is equal.
 */
export function basisEquals(left: CompactionLatchBasis, right: CompactionLatchBasis): boolean {
  return left.replaceGeneration === right.replaceGeneration
    && left.conversation.provider === right.conversation.provider
    && left.conversation.model === right.conversation.model
    && left.summarization.provider === right.summarization.provider
    && left.summarization.model === right.summarization.model
    && left.capacityIdentity === right.capacityIdentity
    && left.effectiveOutputReserve === right.effectiveOutputReserve
    && left.tokenizerSafetyMargin === right.tokenizerSafetyMargin
    && left.passPolicy.maxPasses === right.passPolicy.maxPasses
    && left.passPolicy.retainTokens === right.passPolicy.retainTokens
    && left.passPolicyRevision === right.passPolicyRevision
}

/** Stable identity of one latch key inside a session's record store. */
function latchKeyOf(key: CompactionLatchKey): string {
  return `${key.replaceGeneration}\u0000${key.conversation.provider}\u0000${key.conversation.model}`
    + `\u0000${key.summarization.provider}\u0000${key.summarization.model}`
    + `\u0000${key.capacityIdentity}\u0000${key.effectiveOutputReserve}\u0000${key.tokenizerSafetyMargin}`
    + `\u0000${key.passPolicy.maxPasses}\u0000${key.passPolicy.retainTokens}`
    + `\u0000${key.passPolicyRevision}\u0000${key.failureClass}`
}

/**
 * The active latch record suppressing an automatic attempt under `basis`.
 * Automatic and manual passes carry different pass policies, so one session
 * keeps records for several bases at once; any latched match holds.
 * @param records - the session's current latch records.
 * @param basis - the operational basis the attempt would run under.
 * @returns the held record whose cause must be reported, or `undefined`.
 */
export function heldLatchRecord(
  records: ReadonlyMap<string, LatchRecord> | undefined,
  basis: CompactionLatchBasis,
): LatchRecord | undefined {
  if (records === undefined) return undefined
  for (const record of records.values()) {
    if (record.latched && basisEquals(record.key, basis)) return record
  }
  return undefined
}

/**
 * Record one deterministic failure outcome. The first failure under a basis
 * stays unlatched so exactly one confirmation attempt may follow; a second
 * failure under the identical basis and class latches. A manual probe that
 * reproduces a held classification re-latches immediately without disturbing
 * other bases' records.
 * @param records - the session's current latch records, mutated in place.
 * @param basis - the operational basis the attempt ran under.
 * @param failureClass - the deterministic classification of the failure.
 * @param cause - diagnostic retained as the held cause.
 */
export function recordDeterministicFailure(
  records: Map<string, LatchRecord>,
  basis: CompactionLatchBasis,
  failureClass: DeterministicFailureClass,
  cause: string,
): void {
  const key = deepFreeze({ ...basis, failureClass })
  const identity = latchKeyOf(key)
  const existing = records.get(identity)
  const deterministicFailures = existing === undefined ? 1 : existing.deterministicFailures + 1
  records.set(identity, {
    key,
    cause,
    deterministicFailures,
    latched: deterministicFailures >= 2,
  })
}

/** One locally reproducible compaction-policy failure. */
export class DeterministicCompactionError extends Error {
  /**
   * @param failureClass - frozen deterministic class carried into latch keys.
   * @param message - complete diagnostic for logs and held-cause reporting.
   * @param options - optional original failure.
   */
  constructor(
    readonly failureClass: DeterministicFailureClass,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'DeterministicCompactionError'
  }
}

/** Stable machine-routing code of a harness/provider error, when present. */
function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    && typeof (error).code === 'string'
    ? (error as { code: string }).code
    : undefined
}

/** Rendered message of an unknown error, blank when unavailable. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : ''
}
