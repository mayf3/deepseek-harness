/**
 * Temporary production-code probe for the request-review workflow.
 *
 * @module @deepseek-ai/dsh-subagent
 */

/**
 * Decide whether a smoke-probe value enables review routing.
 * @param value - Candidate smoke-probe value.
 * @returns Whether the normalized value is `enabled`.
 */
export function requestReviewSmokeEnabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'enabled'
}
