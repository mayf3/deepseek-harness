# Agent Note: Policy versus maximum context windows and compaction admission

Status: proposed

English | [中文](2026-08-21-policy-versus-maximum-context-window-and-compaction-admission.zh.md)

## Problem

One long-running session grew to roughly 600k input tokens on a 1,000,000-token window model, then rerouted mid-session to a model whose installed pi-ai catalog entry resolves `contextWindow` 272000. The deployment's own local model metadata for that same route carries two distinct facts: `context_window` 272000 and `max_context_window` 872000. The harness vocabulary has one capacity per model, so only the first fact exists for it.

After the reroute, every automatic compaction failed. Of 270 `compaction/start` events in the session, 266 end with the identical error `pi-ai detected context overflow for model "gpt-5.6-sol"` between 2026-08-20T20:48:40+08:00 and 2026-08-21T06:51:27+08:00; one further close reports `terminated` and one `fetch failed`; the only two successful compactions predate the reroute and ran on the 1,000,000-token model. The largest observed successful request through the 272000-window route carries 615,520 input tokens, so the provider served inputs well above the catalog number while the harness kept calling them overflow.

The misclassification mechanism is in `packages/llm/llm-pi-ai/src/stream.ts`: `mapStopReason` feeds pi-ai's `isContextOverflow` the single resolved `contextWindow`, and that heuristic — written for providers that silently truncate input — treats any `stopReason: 'stop'` response with `usage.input + cacheRead > contextWindow` as overflow. The compaction summarizer replays the conversation prefix (system, tools, selected region) plus the compaction instruction through the same route and terminates in `stop`; above 272000 input every such successful response is reclassified as `CONTEXT_WINDOW_EXCEEDED`, so the compaction transaction can never close. Main tool-use requests terminate in `toolUse`, which the heuristic does not inspect, which is why the session itself kept working while compaction spun.

The repetition is structural. `maxOverflowRetries` gates only the `agent/request-error` recovery sequence in `packages/compaction/compaction-basic/src/index.ts`, and those request errors never fire because the main requests succeed. The `agent/pre-step` pressure handler catches each compaction failure with a warning and continues the turn, so the same deterministic failure re-ran before every following tool step: 260 of the 270 starts sit inside a single turn at a median interval of 85 seconds.

Three further gaps complete the picture. Region selection for overflow recovery calls `selectCompactableRange` with `retainTokens=0` — the largest balanced old region — and pressure selection retains a fraction of the same window, but neither proves that the resulting summarization request plus its output reserve fits the summarization model's combined request-and-response context. One `contextWindow` drives both the proactive pressure threshold and the overflow verdict. The observed `openai-codex` route is owned by external `dsh-codex`, which directly constructs `PiAiAdapter` from `openaiCodexProvider()` and does not pass through the ordinary llm-pi-ai settings catalog, so changing only catalog materialization cannot deliver its route-local capacity.

## Proposal

Freeze the following provider-neutral, model-neutral behavior. Core code names no provider or model and reads no Codex-specific file; adapters resolve route-local facts through the generic LLM vocabulary.

### Combined capacities and authority

`contextWindow` is the active combined context: the maximum combined request-plus-response context the route currently runs with, and the capacity that drives pressure, compaction admission, and switch preflight. `maxContextWindow` is an override ceiling: the largest combined context an explicit configuration override may raise the active context to. The ceiling alone never changes the active context, never states a provider hard limit, and never serves as an overflow-classification authority. Both fields mean combined request-plus-response context, never input-only capacity. A single disclosed number serves as the active context, and no code path infers an active context from a ceiling without an explicit override.

Each field resolves through one adapter-owned authority chain: explicit deployment configuration over route-local capability metadata over an installed catalog entry over the route fallback. Ordinary llm-pi-ai settings routes can provide both capacities through `models` or `modelOverrides`; any adapter, including an external adapter, can instead return them directly from `resolveModel`. The generic field names and validation belong to `@deepseek-ai/dsh-llm`; Core never reads a Codex capability file and never branches on a provider or model name.

Resolution validates positive integers and `contextWindow <= maxContextWindow` when both are disclosed; an active context above its override ceiling fails at load naming the offending key. The resolved combined context is `resolvedContextWindow = contextWindow ?? maxContextWindow`: the active context when disclosed, the ceiling only when the active context is absent. A route may also disclose `effectiveContextWindowPercent`, a positive percentage no greater than 100; omission means 100 percent. The percentage applies to the resolved context, never to the ceiling: `effectiveContextBudget = floor(resolvedContextWindow * effectiveContextWindowPercent / 100)`. For the observed metadata — active context 272000, ceiling 872000, 95 percent — the resolved context is 272000 and the effective budget is 258400; 828400 arises only after an explicit, legal override raises the active context to the ceiling.

The adapter returns one immutable capacity snapshot containing `resolvedContextWindow`, the optional override ceiling, the effective percentage, `effectiveContextBudget`, the silent-overflow capability, and each field's metadata provenance and authority. Admission, latching, diagnostics, and switch preflight use that same snapshot for one operation. If a route ever needs a provider-confirmed hard limit as a distinct fact, the adapter must declare it in a separately proven field; it is never inferred from an override ceiling. A deployment-local capability file is evidence for its route in that deployment only and is never promoted to a global catalog fact.

### Successful response authority

A recognized provider overflow error remains final authority and maps to canonical `CONTEXT_WINDOW_EXCEEDED` regardless of local metadata. A completed response with non-empty assistant content remains successful even when reported input usage exceeds any locally disclosed capacity; local metadata cannot rewrite provider success into failure. The adapter records a capacity-metadata-drift diagnostic containing the route, capacity snapshot, and reported usage instead.

Silent-overflow detection is an opt-in route capability resolved by the owning adapter for an exact provider protocol. It is disabled when the capability is absent and must not run merely because a route uses pi-ai. The frozen anomalous signature requires every declared element: a terminal reason explicitly allowed by that capability, no assistant content blocks, zero reported output tokens, and `usage.input + cacheRead >= resolvedContextWindow`. Usage comparison alone is insufficient. Only a capability-enabled route matching the full signature may map the response to canonical overflow; an empty response that does not match remains the ordinary empty-response or max-output outcome.

### Combined-context admission

Every admission decision proves `pricedSystem + pricedTools + pricedSelectedMessages + pricedInstruction + effectiveOutputReserve + tokenizerSafetyMargin <= effectiveContextBudget`. Pricing uses the exact summarization or ordinary request representation that the selected adapter will send. The output reserve is never zero merely because no output exists yet.

The effective percentage is one total-budget reduction applied to the resolved context before all harness arithmetic. The harness claims no knowledge of which upstream reserves that percentage covers, never presents it as already including the system prompt, tools, instruction, or output, and therefore subtracts every precisely priced component and the explicit tokenizer safety margin after it. The only possible overlap is conservative headroom the harness knowingly gives up; no component is deducted twice by the harness itself.

For compaction, `effectiveOutputReserve` is the actual `maxTokens` sent to the summarization call after exact-target policy resolution; the current inherited default of 8192 therefore reserves 8192 tokens. For an ordinary request and switch preflight, it is the explicit request `maxTokens`, otherwise the adapter-owned `defaultMaxTokens` materialized by prepared-call resolution. If neither value exists, capacity-sensitive preflight fails loud rather than assuming zero. `tokenizerSafetyMargin` is a resolved, validated policy value captured in the capacity snapshot key.

When the largest balanced old region exceeds the admission budget, compaction proceeds in multiple balanced, bounded passes. Each pass summarizes exactly the span it replaces and lands its own checkpoint. Compaction never summarizes a smaller span while replacing a larger one, never truncates a request and still replaces the full span, and fails loud if no balanced pass can satisfy the formula or the declared pass bound. The per-pass summary-smaller check, tool-call/result pairing balance, and checkpoint provenance (`compaction/summary` with `shadowedRange`, `shadowedSeqs`, `shadowedTokenCount`, and `sourceEventSeqs`) remain mandatory.

### Deterministic failure latch

The latch key contains at least `replaceGeneration`, the conversation provider/model target, the actual summarization provider/model target, the complete resolved capacity snapshot, effective output reserve, tokenizer safety margin, pass policy and its revision, and failure classification. Ordinary assistant/message and tool/result appends do not clear it.

Deterministic classes are locally reproducible admission impossibility, no balanced eligible span, pass-bound or no-progress failure, summary-not-smaller invariant failure, a provider-confirmed `CONTEXT_WINDOW_EXCEEDED`, and a request-size `INVALID_REQUEST` for the identical admitted request. `TRANSPORT`, `SERVER`, `TIMEOUT`, `ABORTED`, rate or quota failures, `terminated`, `fetch failed`, and an incomplete stream are transient and never open the permanent deterministic latch. Other unclassified provider failures remain transient unless this proposal is amended with a reproducibility rule.

Automatic compaction may make at most two provider calls for one unchanged deterministic key: the initial failure and at most one confirmation probe. It then latches, and all automatic pressure checks under that key make zero summarization provider calls while continuing to report the held cause. At least 20 consecutive ordinary tool steps, including their ordinary message and result appends, must not increase the call count.

Manual compaction grants exactly one explicit probe without deleting the held key. Success changes generation and clears the obsolete latch; reproduction of the same deterministic classification immediately re-latches it. The only maintenance action that can clear a latch is an explicit capacity, target, output-reserve, safety-margin, or pass-policy update whose recomputed key differs; generic session maintenance is not a clearing condition.

### Large-to-small switch sequencing

A model switch that may reduce admission capacity runs as one reserved operation: `PREPARE → acquire idle/maintenance reservation → measure → compact with the previous route or an explicit summarization target → remeasure → COMMIT`. The reservation excludes a concurrent next turn and remains held through commit or rollback. Both measurements include priced system, tools, selected messages, instruction where applicable, output reserve, and safety margin.

If remeasurement does not satisfy the target route's admission formula, the operation fails loud, releases the reservation, keeps the previous model selection, performs no partial target commit, and keeps the session id unchanged. Compaction never runs through the uncommitted smaller target unless the operator explicitly selected that route as the separate summarization target.

Session identity, log continuity, and Kernel semantics are unchanged throughout the reserved operation: `agent-loop`, the `SessionEventMap`, and the durable `request/context` payload take no change (Kernel change = NONE); the sequencing lives on the routing surface that stamps the next request's provider and model.

WINDOW and COMPACTION are prerequisites for full precompact-before-commit SWITCH delivery. A SWITCH change that lands before both prerequisites may implement only `REFUSE_ONLY`: it measures with the available conservative capacity and rejects an unsafe switch without attempting precompaction. It must not claim that full precompact-before-commit is independently available.

## Execution handoffs

**Window execution.** Extend `LlmModelContext` and exact-model resolution with the active-context, override-ceiling, and effective-budget capacity snapshot and the opt-in silent-overflow capability. Extend llm-pi-ai `models` and `modelOverrides`, but keep capacity resolution adapter-owned so external adapters can contribute the same fields through `resolveModel`. Retarget stream classification to provider-error authority, metadata-drift reporting, and the capability-gated strong signature. Deliver adapter, catalog, stream, documentation, and changeset coverage.

The verified external integration baseline is `dsh-codex@0.2.4` from `Yan-Zero/dsh-codex` — the installed adapter whose `createOpenAICodexAdapter()` owns the observed route. WINDOW is incomplete until a coordinated dsh-codex change makes `createOpenAICodexAdapter()` translate the route's active `context_window`, override-ceiling `max_context_window`, and `effective_context_window_percent` into the generic snapshot — `resolvedContextWindow`, override ceiling, `effectiveContextBudget` — with each field's provenance; it must resolve the silent-overflow capability as enabled only when protocol evidence proves the frozen signature and otherwise leave it absent or disabled. The change also adds an adapter integration test and publishes an exact dsh-codex package version and source revision pinned to the exact Harness package release containing this vocabulary, recording the baseline's own source revision with that change. Version ranges or an unrecorded local file are not an acceptable handoff.

**Compaction execution.** Add the combined-context admission formula, actual output reserve, tokenizer safety margin, bounded balanced multi-pass selection, and exact deterministic latch to `packages/compaction/compaction-basic`; extend `compaction-loop-repro.spec.ts` with the exact call bounds and transient taxonomy.

**Switch execution.** First land `REFUSE_ONLY` if needed. Full delivery depends on WINDOW and COMPACTION, then adds reservation, previous-route or explicit-target compaction, remeasurement, and atomic commit on the model-switch surface without changing session identity or Kernel semantics.

None of these handoffs is implemented by this note. WINDOW and COMPACTION may land independently; full SWITCH may not land independently of them.

## Alternatives considered

**Classify any completed response above local metadata as overflow.** Rejected: a complete non-empty provider response is stronger evidence than stale local capacity metadata; record drift instead of manufacturing a failure.

**Enable the silent-overflow heuristic for all pi-ai routes.** Rejected: pi-ai is a transport family, not evidence that every provider/protocol silently truncates. Exact route capability plus the full empty-output anomaly is required.

**Treat the override ceiling as the provider hard limit or overflow authority.** Rejected: the ceiling bounds configuration overrides only; a provider hard limit and an overflow-classification authority are separately proven facts, and the silent-overflow signature compares against the resolved context.

**Apply the effective percentage to the override ceiling.** Rejected: the percentage acts on the active and resolved context — 272000 at 95 percent is 258400 — while applying it to 872000 budgets against a window the route does not run unless explicitly overridden.

**Raise the catalog `contextWindow` to the deployment maximum.** Rejected: the policy window is what pressure and admission budget against; inflating it disables proactive compaction below the real maximum and moves every session onto overflow recovery.

**Read Codex metadata in Core or add a Codex model special case.** Rejected: the owning adapter already controls exact-route resolution. A provider-neutral adapter result keeps external routes viable without coupling Core to their files.

**Add per-step backoff to pressure compaction.** Rejected: backoff slows the burn without bounding it; a deterministic failure under unchanged state must stop issuing provider calls entirely, while transient failures remain retryable under their existing policy.

**Commit the smaller route before precompaction.** Rejected: it can strand compaction on the route that cannot admit the existing history and exposes a partial selection when failure occurs.

## Acceptance criteria

- A completed non-empty response whose usage exceeds local `maxContextWindow` remains successful and emits capacity-metadata drift; no generic usage comparison rewrites it as overflow.
- A route without the exact silent-overflow capability never runs the heuristic. A capability-enabled route maps canonical overflow only when its complete terminal-reason, empty-content, zero-output, and usage signature matches. Recognized provider overflow errors remain authoritative.
- Model capacities are documented and tested as combined request-plus-response context. Compaction admission includes the actual summarization `maxTokens`, including the inherited 8192 default, and ordinary/switch preflight includes the materialized request output reserve plus tokenizer safety margin.
- Tests pin `resolvedContextWindow = contextWindow ?? maxContextWindow` and `effectiveContextBudget = floor(resolvedContextWindow * effectiveContextWindowPercent / 100)`: active context 272000 with an override ceiling 872000 at 95 percent resolves to 272000 and budgets 258400, and only an explicit, legal active-context override to the ceiling yields 828400.
- A configuration whose active context exceeds its override ceiling fails at resolution naming the offending key; the ceiling's presence alone never changes the active context, never states a provider hard limit, and never classifies overflow.
- A dsh-codex adapter integration test at the coordinated exact package/revision proves `openai-codex` contributes route-local capacities through `resolveModel`; Core reads no Codex file and contains no provider/model special case.
- Under one unchanged deterministic latch key, `CALLS_BEFORE_LATCH <= 2` and `CALLS_WHILE_LATCHED = 0`; at least 20 consecutive ordinary tool steps do not increase calls. Transient `TRANSPORT`, `SERVER`, `TIMEOUT`, `terminated`, and `fetch failed` cases do not permanently latch, and a failed manual probe re-latches immediately.
- Switch tests prove reservation excludes a concurrent turn, summarization uses the previous route or explicit summarization target, remeasurement precedes commit, and failure leaves the previous selection, no partial target state, and the same session id; both preflight measurements and compaction admission consume the same immutable capacity snapshot.
- Handoff tests and documentation state that full SWITCH depends on WINDOW and COMPACTION; any earlier SWITCH delivery is named `REFUSE_ONLY` and does not claim precompact-before-commit support.
- Tool-call/result pairing balance, the per-pass summary-smaller check, checkpoint provenance, and fail-loud behavior survive every compaction path; the three handoffs carry their focused tests, affected documentation, changesets, and integration pins.

## Risks

**Capacity metadata can be stale in either direction.** Provider-confirmed overflow remains authoritative, complete non-empty success produces drift rather than failure, and the effective percentage plus safety margin protects admission without pretending metadata is provider truth.

**Admission budgets can fragment history into many passes.** The declared pass bound plus the per-pass summary-smaller invariant keeps convergence observable; reaching the bound fails loud instead of looping.

**The latch can hide a recoverable cause.** Only the frozen deterministic taxonomy can latch; transient classes cannot. The exact key, one-probe manual behavior, and held-cause diagnostics expose when a meaningful state change permits another attempt.

**Cross-repository delivery can drift.** The verified dsh-codex baseline and the required exact final package/revision pins make the external adapter change part of WINDOW acceptance rather than an assumed follow-up.

**Switch reservation can delay a turn.** The reservation is limited to prepare, measure, optional compaction, remeasure, and commit or rollback; it buys an atomic selection and a stable measurement.
