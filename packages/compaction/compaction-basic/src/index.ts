/**
 * Basic replay-aware compaction backend.
 *
 * @module @deepseek-ai/dsh-compaction-basic
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CompactionEngine, ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import type { Session } from '@deepseek-ai/dsh-session'
import { CONTEXT_WINDOW_EXCEEDED_CODE, assertNever } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
// Type-only: makes the optional sibling service available to `ctx.get()`.
import type {} from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import {
  resolveCompactSpec,
  resolveConfig,
  resolveTargetPolicy,
  TargetPressureConfigError,
} from './config.ts'
import type { ResolvedTargetPolicy } from './types.ts'
import {
  assertNoActiveCompaction,
  compactSurfaceRegion,
  selectAdmittedCompactionRange,
  selectCompactableRange,
  validateSurfaceRegion,
} from './region.ts'
import { compactionInstructionMessage, resolveSummarizationTarget, summarizeWithLlm } from './summarizer.ts'
import type { SummarizationInput, SummaryResult } from './summarizer.ts'
import { evaluateAdmission, renderAdmission } from './admission.ts'
import { resolveCapacitySnapshot } from './capacity.ts'
import type { ResolvedCapacitySnapshot } from './capacity.ts'
import {
  classifyFailure,
  DeterministicCompactionError,
  heldLatchRecord,
  PASS_POLICY_REVISION,
  recordDeterministicFailure,
} from './latch.ts'
import type {
  CompactionLatchBasis,
  LatchRecord,
} from './latch.ts'
import type {
  BasicCompactionConfig,
  ModelCompactPolicyConfig,
  ResolvedConfig,
} from './types.ts'

export type {
  BasicCompactionConfig,
  CompactionPolicyConfig,
  ModelCompactPolicyConfig,
  ResolvedCompactSpec,
  ResolvedConfig,
  ResolvedRetention,
  ResolvedTargetPolicy,
} from './types.ts'
export { evaluateAdmission, renderAdmission } from './admission.ts'
export type { AdmissionComponents, AdmissionDecision } from './admission.ts'
export { resolveCapacitySnapshot } from './capacity.ts'
export type { CapacityTarget, ResolvedCapacitySnapshot } from './capacity.ts'
export {
  basisEquals,
  classifyFailure,
  DeterministicCompactionError,
  heldLatchRecord,
  PASS_POLICY_REVISION,
  recordDeterministicFailure,
} from './latch.ts'
export type {
  CompactionLatchBasis,
  CompactionLatchKey,
  DeterministicFailureClass,
  FailureClassification,
  LatchRecord,
} from './latch.ts'
export { selectAdmittedCompactionRange, selectCompactableRange } from './region.ts'
export { compactionInstructionMessage, resolveSummarizationTarget } from './summarizer.ts'

/** The region transaction's view of this service's dynamically dispatched summarizer. */
type RegionSummarize = (input: SummarizationInput, agent: Agent, signal?: AbortSignal) => Promise<SummaryResult>

/** Resolve the exact provider/model durably routed for the latest request. */
function routedTarget(
  session: Session,
): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  const config = session.requestHeader()?.config
  if (config === undefined || config.provider.length === 0 || config.model.length === 0) {
    return undefined
  }
  return { provider: config.provider, model: config.model }
}

/** Resolve the conversation target used to select an optional policy override. */
function conversationTarget(
  agent: Agent,
): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  const routed = routedTarget(agent.session)
  if (routed !== undefined) return routed
  if (agent.options.provider === undefined || agent.options.provider.length === 0
    || agent.options.model === undefined || agent.options.model.length === 0) return undefined
  return { provider: agent.options.provider, model: agent.options.model }
}

const thresholdRatioSchema = z.number()
const retainRatioSchema = z.number()
const retainTokensSchema = z.number().step(1).min(0)
const summarizationProviderSchema = z.string()
const summarizationModelSchema = z.string()
const maxTokensSchema = z.number().step(1).min(1)
const tokenizerSafetyMarginSchema = z.number().step(1).min(0)
const compactionRetriesSchema = z.number().step(1).min(0)
const maxOverflowRetriesSchema = z.number().step(1).min(0)

const modelPolicy: z<ModelCompactPolicyConfig> = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  thresholdRatio: thresholdRatioSchema,
  retainRatio: retainRatioSchema,
  retainTokens: retainTokensSchema,
  summarizationProvider: summarizationProviderSchema,
  summarizationModel: summarizationModelSchema,
  maxTokens: maxTokensSchema,
  tokenizerSafetyMargin: tokenizerSafetyMarginSchema,
  compactionRetries: compactionRetriesSchema,
  maxOverflowRetries: maxOverflowRetriesSchema,
})

/**
 * Dependency-light compaction backend using `ctx.tokenMeter` for pressure,
 * retention, cited source events, and summary-convergence pricing.
 *
 * `summarize()` is the sole subclass customization hook; the replay and durable
 * mutation strategy stays fixed so every pricing decision uses the singleton
 * token meter.
 */
export class BasicCompactionEngine extends CompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions']

  static Config: z<BasicCompactionConfig> = z.object({
    thresholdRatio: thresholdRatioSchema,
    retainRatio: retainRatioSchema,
    retainTokens: retainTokensSchema,
    summarizationProvider: summarizationProviderSchema,
    summarizationModel: summarizationModelSchema,
    maxTokens: maxTokensSchema,
    tokenizerSafetyMargin: tokenizerSafetyMarginSchema,
    compactionRetries: compactionRetriesSchema,
    maxOverflowRetries: maxOverflowRetriesSchema,
    modelPolicies: z.array(modelPolicy),
    auto: z.boolean(),
  })

  /** Resolved and validated compaction configuration. */
  readonly config: ResolvedConfig

  private readonly warnedPressureConfigTargets = new Set<string>()
  private readonly overflowRetries = new WeakMap<Agent, number>()
  private readonly overflowAgents = new WeakMap<Session, Agent>()
  /** In-memory deterministic latch records per session; durable replacements obsolete them. */
  private readonly latches = new WeakMap<Session, Map<string, LatchRecord>>()

  constructor(ctx: Context, config: BasicCompactionConfig = {}) {
    super(ctx)
    this.config = resolveConfig(config)
    if (this.config.auto) this._registerAutomaticCompaction()
  }

  /**
   * Register automatic between-step pressure and model-request overflow
   * recovery. `compactIfNeeded` stays dynamically dispatched so subclass
   * overrides are honored at event time.
   */
  private _registerAutomaticCompaction(): void {
    const { ctx } = this
    const logResult = (result: CompactionResult, trigger: string): void => {
      ctx.logger.info(
        `compaction (${trigger}): shadowed ${result.shadowedSeqs.length} surface nodes `
        + `(seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, `
        + `~${result.shadowedTokenCount} tokens)`,
      )
    }

    ctx.on('agent/pre-step', async (
      { agent, signal },
      next,
    ): Promise<PreStepDecision> => {
      if (!signal.aborted) {
        try {
          const result = await this.compactIfNeeded(agent, 'pressure', signal)
          if (result !== null) logResult(result, 'step pressure')
        } catch (error: unknown) {
          if (error instanceof TargetPressureConfigError) {
            if (this.warnedPressureConfigTargets.has(error.targetKey)) return next()
            this.warnedPressureConfigTargets.add(error.targetKey)
          }
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`step compaction failed: ${message}; continuing the turn`)
        }
      }
      return next()
    })

    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this.overflowRetries.delete(agent)
    })

    // A successful response starts a fresh overflow-recovery sequence even
    // when tool calls continue the same turn into another request.
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return
      const agent = this.overflowAgents.get(session)
      if (agent !== undefined) this.overflowRetries.delete(agent)
    })

    ctx.on('agent/request-error', async (
      { agent, failure, signal },
      next,
    ) => {
      if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next()
      this.overflowAgents.set(agent.session, agent)
      const target = routedTarget(agent.session)
      if (target === undefined) return next()
      const policy = resolveTargetPolicy(this.config, target)
      const retries = this.overflowRetries.get(agent) ?? 0
      if (retries >= policy.maxOverflowRetries) return next()

      const generation = agent.session.surface.replaceGeneration
      let result: CompactionResult | null
      try {
        result = await this.compactIfNeeded(agent, 'context-overflow', signal)
      } catch (recoveryError: unknown) {
        const message = recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
        // A model-free prune can land before later summary work fails. That
        // durable reduction is sufficient retry proof; do not discard it just
        // because the optional second phase threw. Cancellation still wins.
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while recovery is awaited.
        if (!signal.aborted && agent.session.surface.replaceGeneration > generation) {
          ctx.logger.warn(
            `context-overflow compaction failed after durable surface progress: ${message}; `
            + 'retrying from the replacement surface',
          )
          this.overflowRetries.set(agent, retries + 1)
          return { kind: 'retry' }
        }
        ctx.logger.warn(
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while recovery is awaited.
          `context-overflow compaction failed: ${message}; ${signal.aborted
            ? 'cancellation prevents retry'
            : 'preserving the original request error'}`,
        )
        return next()
      }
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while compaction is awaited.
      if (signal.aborted
        || agent.session.surface.replaceGeneration <= generation) return next()
      if (result !== null) logResult(result, 'context overflow recovery')
      this.overflowRetries.set(agent, retries + 1)
      return { kind: 'retry' }
    })
  }

  /**
   * Summarize the replayed conversation region through a direct one-shot
   * `ctx.llm.stream()` call whose prefix reuses the conversation's own system
   * prompt, tools, and messages so the provider's KV cache is not invalidated.
   * Override this sole hook for a template or remote summarizer.
   * @param input - replayed conversation prefix (system, tools, and leading messages) to condense.
   * @param agent - supplies routed-model history, fallback model, and session id.
   * @param signal - optional cancellation forwarded to the adapter.
   * @returns safe text summary blocks and the exact auxiliary call envelope and output.
   */
  protected async summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    return summarizeWithLlm(this.ctx, this._policyFor(agent), input, agent, signal)
  }

  /**
   * Compact for replayed step-boundary pressure or one provider-confirmed context
   * overflow. Both triggers price the latest durable routed request envelope;
   * overflow bypasses the normal threshold and retained-tail policy so it can
   * force one useful balanced reduction. Every summarization call is gated by
   * combined-context admission and the deterministic failure latch.
   * @param agent - agent whose latest durable routed request is measured.
   * @param trigger - normal step-boundary pressure or context-overflow recovery.
   * @param signal - live turn cancellation signal forwarded to summarization.
   * @returns the latest summary compaction result, or `null` when no summary ran.
   */
  override async compactIfNeeded(
    agent: Agent,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    const target = routedTarget(agent.session)
    if (target === undefined) return null
    const policy = resolveTargetPolicy(this.config, target)
    const meter = this.ctx.tokenMeter
    let measurement = meter.measure(agent.session)
    switch (trigger) {
      case 'context-overflow':
        break
      case 'pressure':
        break
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        assertNever(trigger, 'compaction trigger')
    }

    // Pruning is optional so compaction-basic remains independently composable.
    // Overflow always qualifies; pressure first resolves the routed model's
    // capacity and checks its target-specific threshold.
    const prune = this.ctx.get('toolResultPruner')

    if (trigger === 'context-overflow') {
      if (prune !== undefined) {
        prune.pruneSession(agent.session)
        measurement = meter.measure(agent.session)
      }
      const range = selectCompactableRange(agent.session, measurement, 0)
      if (range === null) return null
      return this._latchedAttempt(agent, policy, 0, signal, async (operation) => {
        const budget = this._selectedMessagesBudget(operation, policy)
        if (budget <= 0) throw this._admissionImpossible(operation, policy)
        const admitted = selectAdmittedCompactionRange(agent.session, measurement, 0, budget)
        if (admitted === null) {
          throw new DeterministicCompactionError(
            'no-balanced-eligible-span',
            `context-overflow compaction: no balanced span fits the ${budget}-token selected-messages budget`,
          )
        }
        return this.compactRegion(admitted.start, admitted.end, agent, signal)
      })
    }

    const context = (await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)).context
    assertNoActiveCompaction(agent.session, 'automatic pressure compaction')
    const targetKey = `${target.provider}/${target.model}`
    if (context === undefined) {
      throw new TargetPressureConfigError(
        targetKey,
        `compaction-basic: no context capacity for ${targetKey}; `
        + 'configure contextWindow on that adapter model',
      )
    }
    const spec = resolveCompactSpec(policy, context.contextWindow)
    if (measurement.totalTokens < spec.thresholdTokens) return null

    // Once pressure qualifies, land the model-free pass before choosing a
    // summary range, then remeasure through the singleton replay fold.
    if (prune !== undefined) {
      prune.pruneSession(agent.session)
      measurement = meter.measure(agent.session)
    }
    if (measurement.totalTokens < spec.thresholdTokens) return null

    return this._latchedAttempt(agent, policy, spec.retainTokens, signal, async (operation) => {
      const session = agent.session
      let current = measurement
      let result: CompactionResult | null = null
      const maxPasses = spec.compactionRetries + 1
      for (let pass = 1; pass <= maxPasses; pass += 1) {
        if (selectCompactableRange(session, current, spec.retainTokens) === null) {
          /* v8 ignore else -- a landed pass preserves a compactable checkpoint; selection cannot outlive the surface. */
          if (result === null) return null
          /* v8 ignore next -- paired with the defensive post-success branch above. */
          break
        }
        const budget = this._selectedMessagesBudget(operation, policy)
        if (budget <= 0) throw this._admissionImpossible(operation, policy)
        const range = selectAdmittedCompactionRange(session, current, spec.retainTokens, budget)
        if (range === null) {
          throw new DeterministicCompactionError(
            'no-balanced-eligible-span',
            `pass ${pass} of ${maxPasses}: no balanced span fits the ${budget}-token selected-messages budget`,
          )
        }
        const beforeSurface = current.surfaceTokens
        result = await this.compactRegion(range.start, range.end, agent, signal)
        current = meter.measure(session)
        /* v8 ignore next 5
         * -- the per-pass summary-smaller invariant guarantees the strict decrease; this guard only fails loud on a meter regression. */
        if (current.surfaceTokens >= beforeSurface) {
          throw new DeterministicCompactionError(
            'no-progress',
            `pass ${pass} of ${maxPasses} did not reduce surface tokens `
              + `(${current.surfaceTokens} >= ${beforeSurface})`,
          )
        }
        if (current.totalTokens < spec.thresholdTokens) return result
      }
      throw new DeterministicCompactionError(
        'pass-bound-exceeded',
        `compaction still above threshold after ${maxPasses} admitted passes `
          + `(${current.totalTokens} estimated tokens >= threshold ${spec.thresholdTokens})`,
      )
    })
  }

  /**
   * Compact one inclusive positional range from the agent-owned surface using
   * the effective token meter for all retention and shrink pricing. The exact
   * requested span must satisfy combined-context admission; a span that cannot
   * be admitted fails loud rather than being truncated or narrowed.
   * @param start - inclusive first surface-node seq.
   * @param end - inclusive last surface-node seq.
   * @param agent - owner of the target session, used by the summarizer.
   * @param signal - optional summarization cancellation signal.
   * @returns the successful durable compaction result.
   */
  override async compactRegion(
    start: number,
    end: number,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    const session = agent.session
    validateSurfaceRegion(session, start, end)
    const policy = this._policyFor(agent)
    const inputs = await this._resolveAdmissionInputs(agent, policy, signal)
    if (inputs !== undefined) {
      const components = {
        pricedSystem: inputs.envelope.systemTokens,
        pricedTools: inputs.envelope.toolsTokens,
        pricedSelectedMessages: this._pricedSurfaceSpan(session, start, end),
        pricedInstruction: inputs.pricedInstruction,
        effectiveOutputReserve: policy.maxTokens,
        tokenizerSafetyMargin: policy.tokenizerSafetyMargin,
        effectiveContextBudget: inputs.capacity.effectiveContextBudget,
      }
      const decision = evaluateAdmission(components)
      if (!decision.admitted) {
        throw new DeterministicCompactionError('admission-impossible', renderAdmission(components))
      }
    }
    return compactSurfaceRegion(
      this.regionDependencies(),
      session,
      start,
      end,
      agent,
      { owner: 'current-turn', stability: 'whole-surface' },
      signal,
    )
  }

  /**
   * Force one useful idle-session compaction below the pressure threshold, and
   * resolve only after its standalone marker pair is durably checkpointed.
   * This is the one explicit manual probe: it runs even under a held latch,
   * never deletes the held key first, re-latches immediately when the same
   * deterministic failure reproduces, and obsoletes the latch through its
   * replacement when it succeeds.
   * @param agent - idle agent whose next-turn admission this call reserves.
   * @param signal - cancellation scoped to this compaction request.
   * @param sourceCommandId - initiating command identity for presentation correlation.
   * @returns the committed result, or `null` when no safe useful range exists.
   */
  override compactNow(
    agent: Agent,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted()
    try {
      return agent.runMaintenance(async (agentSignal) => {
        const operationSignal = AbortSignal.any([agentSignal, signal])
        try {
          operationSignal.throwIfAborted()
          const session = agent.session
          const meter = this.ctx.tokenMeter
          const measurement = meter.measure(session)
          if (selectCompactableRange(session, measurement, 0) === null) return null
          const policy = this._policyFor(agent)
          const inputs = await this._resolveAdmissionInputs(agent, policy, operationSignal)
          if (inputs !== undefined) {
            const basis = this._latchBasis(agent, policy, inputs, 0)
            try {
              const budget = this._selectedMessagesBudget(inputs, policy)
              if (budget <= 0) throw this._admissionImpossible(inputs, policy)
              const range = selectAdmittedCompactionRange(session, meter.measure(session), 0, budget)
              if (range === null) {
                throw new DeterministicCompactionError(
                  'no-balanced-eligible-span',
                  `manual compaction: no balanced span fits the ${budget}-token selected-messages budget`,
                )
              }
              const result = await compactSurfaceRegion(
                this.regionDependencies(),
                session,
                range.start,
                range.end,
                agent,
                this._manualTransactionOptions(session, sourceCommandId),
                operationSignal,
              )
              this.latches.delete(session)
              return result
            } catch (error: unknown) {
              this._recordLatchOutcome(session, basis, error)
              if (error instanceof ManualCompactionError) throw error
              if (error instanceof DeterministicCompactionError) {
                throw new ManualCompactionError(
                  'summary',
                  'manual compaction could not admit or replace its selected span',
                  { cause: error },
                )
              }
              throw error
            }
          }
          return await this._manualUnroutedCompaction(agent, sourceCommandId, operationSignal)
        } catch (error: unknown) {
          if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) {
            throw new ManualCompactionError(
              'cancelled',
              'manual compaction was cancelled',
              { cause: error },
            )
          }
          operationSignal.throwIfAborted()
          throw error
        }
      })
    } catch (error: unknown) {
      throw new ManualCompactionError(
        'busy',
        'manual compaction requires an idle agent with no waking queued work',
        { cause: error },
      )
    }
  }

  /** Resolve the conversation policy the summarizer itself would use. */
  private _policyFor(agent: Agent): ResolvedTargetPolicy | ResolvedConfig {
    const target = conversationTarget(agent)
    return target === undefined ? this.config : resolveTargetPolicy(this.config, target)
  }

  /** Priced fixed components plus the resolved capacity for admission. */
  private async _resolveAdmissionInputs(
    agent: Agent,
    policy: AdmissionPolicy,
    signal?: AbortSignal,
  ): Promise<AdmissionInputs | undefined> {
    const target = resolveSummarizationTarget(policy, agent)
    if (target === undefined) return undefined
    const capacity = await resolveCapacitySnapshot(this.ctx, target, signal)
    return {
      capacity,
      envelope: this.ctx.tokenMeter.estimateEnvelopeParts(agent.session.requestHeader()),
      pricedInstruction: this.ctx.tokenMeter.estimateMessage(compactionInstructionMessage()),
    }
  }

  /** The selected-messages budget left after every fixed component and reserve. */
  private _selectedMessagesBudget(inputs: AdmissionInputs, policy: AdmissionPolicy): number {
    return evaluateAdmission({
      pricedSystem: inputs.envelope.systemTokens,
      pricedTools: inputs.envelope.toolsTokens,
      pricedSelectedMessages: 0,
      pricedInstruction: inputs.pricedInstruction,
      effectiveOutputReserve: policy.maxTokens,
      tokenizerSafetyMargin: policy.tokenizerSafetyMargin,
      effectiveContextBudget: inputs.capacity.effectiveContextBudget,
    }).selectedMessagesBudget
  }

  /** The fail-loud no-span-can-ever-fit admission verdict for diagnostics. */
  private _admissionImpossible(inputs: AdmissionInputs, policy: AdmissionPolicy): DeterministicCompactionError {
    return new DeterministicCompactionError('admission-impossible', renderAdmission({
      pricedSystem: inputs.envelope.systemTokens,
      pricedTools: inputs.envelope.toolsTokens,
      pricedSelectedMessages: 0,
      pricedInstruction: inputs.pricedInstruction,
      effectiveOutputReserve: policy.maxTokens,
      tokenizerSafetyMargin: policy.tokenizerSafetyMargin,
      effectiveContextBudget: inputs.capacity.effectiveContextBudget,
    }))
  }

  /** Sum of metered node prices across one inclusive surface span. */
  private _pricedSurfaceSpan(session: Session, start: number, end: number): number {
    const nodes = this.ctx.tokenMeter.measure(session).nodes
    const startIndex = nodes.findIndex(node => node.seq === start)
    const endIndex = nodes.findIndex(node => node.seq === end)
    if (startIndex === -1 || endIndex === -1 || startIndex > endIndex) {
      throw new Error('compaction: selected surface changed before summarization began')
    }
    let total = 0
    for (let index = startIndex; index <= endIndex; index += 1) {
      // oxlint-disable-next-line typescript/no-non-null-assertion
      total += nodes[index]!.tokens
    }
    return total
  }

  /** Build the latch basis for one operation; a conversation-less session keys on its summarization route. */
  private _latchBasis(
    agent: Agent,
    policy: AdmissionPolicy,
    inputs: AdmissionInputs,
    effectiveRetainTokens: number,
  ): CompactionLatchBasis {
    const conversation = conversationTarget(agent) ?? {
      provider: inputs.capacity.target.provider,
      model: inputs.capacity.target.model,
    }
    return {
      replaceGeneration: agent.session.surface.replaceGeneration,
      conversation,
      summarization: { provider: inputs.capacity.target.provider, model: inputs.capacity.target.model },
      capacityIdentity: inputs.capacity.identity,
      effectiveOutputReserve: policy.maxTokens,
      tokenizerSafetyMargin: policy.tokenizerSafetyMargin,
      passPolicy: { maxPasses: policy.compactionRetries + 1, retainTokens: effectiveRetainTokens },
      passPolicyRevision: PASS_POLICY_REVISION,
    }
  }

  /**
   * Run one automatic compaction attempt under the deterministic latch. A held
   * key reports its cause and makes no summarization call; a deterministic
   * failure records toward the two-call latch bound; a durable success
   * obsoletes any held key through its `replaceGeneration` advance.
   */
  private async _latchedAttempt(
    agent: Agent,
    policy: AdmissionPolicy,
    effectiveRetainTokens: number,
    signal: AbortSignal | undefined,
    run: (operation: AdmissionInputs) => Promise<CompactionResult | null>,
  ): Promise<CompactionResult | null> {
    const session = agent.session
    const inputs = await this._resolveAdmissionInputs(agent, policy, signal)
    /* v8 ignore next 4
     * -- compactIfNeeded callers pass through a durable routed target, so the summarization target always resolves here. */
    if (inputs === undefined) {
      throw new Error(
        'no provider/model available for summarization: set both BasicCompactionConfig summarization fields, route one request, or set both AgentOptions fields',
      )
    }
    const basis = this._latchBasis(agent, policy, inputs, effectiveRetainTokens)
    const held = heldLatchRecord(this.latches.get(session), basis)
    if (held !== undefined) {
      this.ctx.logger.warn(
        `automatic compaction held (${held.key.failureClass}): ${held.cause}`,
      )
      return null
    }
    try {
      const result = await run(inputs)
      if (result !== null) this.latches.delete(session)
      return result
    } catch (error: unknown) {
      this._recordLatchOutcome(session, basis, error)
      throw error
    }
  }

  /** Record one deterministic outcome; transient and cancelled failures leave the latches unchanged. */
  private _recordLatchOutcome(session: Session, basis: CompactionLatchBasis, error: unknown): void {
    const classification = classifyFailure(error)
    if (classification.kind !== 'deterministic') return
    const records = this.latches.get(session) ?? new Map<string, LatchRecord>()
    this.latches.set(session, records)
    recordDeterministicFailure(
      records,
      basis,
      classification.failureClass,
      /* v8 ignore next -- only classified failures reach the recorder, and every deterministic class is an Error. */
      error instanceof Error ? error.message : String(error),
    )
  }

  /** Manual compaction fallback when no summarization target exists at all. */
  private async _manualUnroutedCompaction(
    agent: Agent,
    sourceCommandId: CommandId | undefined,
    operationSignal: AbortSignal,
  ): Promise<CompactionResult> {
    const range = selectCompactableRange(
      agent.session,
      this.ctx.tokenMeter.measure(agent.session),
      0,
    )
    /* v8 ignore next -- compactNow already rejected a nothing-compactable surface before resolving admission inputs. */
    if (range === null) throw new Error('manual compaction: no compactable range after admission resolution')
    return compactSurfaceRegion(
      this.regionDependencies(),
      agent.session,
      range.start,
      range.end,
      agent,
      this._manualTransactionOptions(agent.session, sourceCommandId),
      operationSignal,
    )
  }

  /** Shared standalone-bracket transaction options for both manual paths. */
  private _manualTransactionOptions(
    session: Session,
    sourceCommandId: CommandId | undefined,
  ): { owner: null; stability: 'selected-span'; sourceCommandId?: CommandId; flush: () => Promise<void> } {
    return {
      owner: null,
      stability: 'selected-span',
      ...sourceCommandId === undefined ? {} : { sourceCommandId },
      flush: async () => {
        await this.ctx.sessions.flush(session)
      },
    }
  }

  /** Bind the effective token meter and dynamically dispatched summarizer hook. */
  private regionDependencies(): { meter: TokenMeter; summarize: RegionSummarize } {
    return {
      meter: this.ctx.tokenMeter,
      summarize: (input, owner, abort) => this.summarize(input, owner, abort),
    }
  }
}

/** Policy whose fields admission and latch keys consume, before or after target matching. */
type AdmissionPolicy = ResolvedTargetPolicy | ResolvedConfig

/** Fixed priced components plus resolved capacity backing admission decisions. */
interface AdmissionInputs {
  readonly capacity: ResolvedCapacitySnapshot
  readonly envelope: { systemTokens: number; toolsTokens: number }
  readonly pricedInstruction: number
}

export default BasicCompactionEngine
