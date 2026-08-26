/**
 * Minimal LLM capacity seam for combined-context admission.
 *
 * WINDOW_INTERFACE_ASSUMPTIONS (single later integration point): this module
 * is the ONLY place compaction-basic reads model capacity. Today the generic
 * vocabulary exposes one combined window per route through
 * `ctx.llm.resolveModelInfo().context.contextWindow`, so that value IS the
 * resolved effective budget (a compatibility fallback, never an inference of
 * a maximum, percentage, or provider metadata). When the WINDOW handoff lands
 * its adapter-owned capacity snapshot (`resolvedContextWindow`,
 * `effectiveContextWindowPercent`, `effectiveContextBudget`), only
 * `resolveCapacitySnapshot` changes: it must then consume the snapshot's
 * `effectiveContextBudget` and fold every snapshot identity field into
 * `identity` so latch keys change with the capacity facts. Nothing else in
 * this package reads capacity.
 *
 * @module @deepseek-ai/dsh-compaction-basic/capacity
 */

import type { Context } from '@deepseek-ai/cordis'
import { TargetPressureConfigError } from './config.ts'

/** One exact provider/model route. */
export interface CapacityTarget {
  readonly provider: string
  readonly model: string
}

/** Immutable resolved capacity snapshot for one summarization route. */
export interface ResolvedCapacitySnapshot {
  /** Route the budget was resolved for. */
  readonly target: CapacityTarget
  /** Combined request-and-response context budget, in tokens. */
  readonly effectiveContextBudget: number
  /** Opaque identity of the capacity facts feeding the budget, for latch keys. */
  readonly identity: string
}

/**
 * Resolve the effective combined-context budget for one exact summarization
 * route through the generic LLM vocabulary. Fails loud when the owning
 * adapter discloses no capacity, because admission cannot prove anything
 * without a budget.
 * @param ctx - context providing the LLM service.
 * @param target - exact provider/model route to resolve.
 * @param signal - optional cancellation for adapter-owned lookup.
 * @returns the immutable capacity snapshot for this operation.
 */
export async function resolveCapacitySnapshot(
  ctx: Context,
  target: CapacityTarget,
  signal?: AbortSignal,
): Promise<ResolvedCapacitySnapshot> {
  const info = await ctx.llm.resolveModelInfo(target.provider, target.model, signal)
  const contextWindow = info.context?.contextWindow
  if (contextWindow === undefined) {
    throw new TargetPressureConfigError(
      `${target.provider}/${target.model}`,
      `compaction-basic: no context capacity for summarization target ${target.provider}/${target.model}; `
      + 'configure contextWindow on that adapter model',
    )
  }
  return {
    target: { provider: target.provider, model: target.model },
    effectiveContextBudget: contextWindow,
    identity: `adapter-resolve-model:${target.provider}/${target.model}#contextWindow=${contextWindow}`,
  }
}
