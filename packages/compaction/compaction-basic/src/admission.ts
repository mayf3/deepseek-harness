/**
 * Pure combined-context admission for summarization requests.
 *
 * The core consumes an already-resolved effective budget and priced request
 * components; it reads no provider metadata and resolves no capacity itself.
 * The LLM capacity seam in `capacity.ts` is the single integration point that
 * supplies `effectiveContextBudget`.
 *
 * @module @deepseek-ai/dsh-compaction-basic/admission
 */

/** Every priced component of one summarization request, plus its budget. */
export interface AdmissionComponents {
  /** Priced system prompt of the exact request representation the adapter sends. */
  readonly pricedSystem: number
  /** Priced tool schemas of the exact request representation the adapter sends. */
  readonly pricedTools: number
  /** Priced selected conversation messages replayed ahead of the instruction. */
  readonly pricedSelectedMessages: number
  /** Priced trailing compaction-instruction user message. */
  readonly pricedInstruction: number
  /** The actual `maxTokens` generation cap the summarization call sends. */
  readonly effectiveOutputReserve: number
  /** Resolved extra admission reserve against estimator drift. */
  readonly tokenizerSafetyMargin: number
  /** Resolved combined request-and-response context budget of the summarization route. */
  readonly effectiveContextBudget: number
}

/** The admission verdict for one priced summarization request. */
export interface AdmissionDecision {
  /** Whether the complete request plus reserves fits the budget. */
  readonly admitted: boolean
  /** Sum of every priced component and reserve. */
  readonly requestTokens: number
  /** Budget remaining for selected messages; negative when over budget. */
  readonly selectedMessagesBudget: number
}

/**
 * Prove `pricedSystem + pricedTools + pricedSelectedMessages + pricedInstruction
 * + effectiveOutputReserve + tokenizerSafetyMargin <= effectiveContextBudget`.
 * The output reserve is never assumed zero: `effectiveOutputReserve` is the
 * actual sent `maxTokens`, and an absent reserve must fail loud at the seam
 * before reaching this core.
 * @param components - fully priced request components and budget.
 * @returns the admission decision with the exact slack for selected messages.
 */
export function evaluateAdmission(components: AdmissionComponents): AdmissionDecision {
  const fixed = components.pricedSystem
    + components.pricedTools
    + components.pricedInstruction
    + components.effectiveOutputReserve
    + components.tokenizerSafetyMargin
  const requestTokens = fixed + components.pricedSelectedMessages
  const selectedMessagesBudget = components.effectiveContextBudget - fixed
  return {
    admitted: requestTokens <= components.effectiveContextBudget,
    requestTokens,
    selectedMessagesBudget,
  }
}

/**
 * Render the complete inequality with every component named, for diagnostics.
 * @param components - fully priced request components and budget.
 * @returns one line stating the priced terms and their sum against the budget.
 */
export function renderAdmission(components: AdmissionComponents): string {
  const { requestTokens } = evaluateAdmission(components)
  return `admission ${components.pricedSystem} (system) + ${components.pricedTools} (tools) `
    + `+ ${components.pricedSelectedMessages} (selected messages) `
    + `+ ${components.pricedInstruction} (instruction) `
    + `+ ${components.effectiveOutputReserve} (output reserve) `
    + `+ ${components.tokenizerSafetyMargin} (safety margin) `
    + `= ${requestTokens} > budget ${components.effectiveContextBudget}`
}
