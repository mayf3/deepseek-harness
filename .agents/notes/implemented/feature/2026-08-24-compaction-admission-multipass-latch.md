# Agent Note: Combined-context admission, bounded multi-pass, and the deterministic compaction latch

Status: implemented

English | [中文](2026-08-24-compaction-admission-multipass-latch.zh.md)

Implements the COMPACTION handoff of the governing proposal [Policy versus maximum context windows and compaction admission](../../proposed/bug-fix/2026-08-21-policy-versus-maximum-context-window-and-compaction-admission.md) in `packages/compaction/compaction-basic`.

## Problem

Automatic compaction issued summarization calls with no proof that the summarization request itself fit the summarization model's combined context: neither the replayed prefix plus instruction nor the actual output reserve was budgeted, and a deterministic failure re-ran before every following tool step (the observed 266 identical overflow-classified compaction attempts in one session).

## Decision

**Admission proves the complete request.** Every summarization call must satisfy `pricedSystem + pricedTools + pricedSelectedMessages + pricedInstruction + effectiveOutputReserve + tokenizerSafetyMargin <= effectiveContextBudget`. Pricing uses the exact representation the adapter sends: the envelope parts through `TokenMeter.estimateEnvelopeParts` (a new instance face of the existing pure envelope estimator, symmetric with `estimateMessage`), selected messages through the meter's own per-node surface prices, and the instruction through pricing the exact message `summarizeWithLlm` appends (`compactionInstructionMessage()`). The output reserve is the resolved `maxTokens` — the inherited 8192 default included — never zero. `tokenizerSafetyMargin` is a validated config field (default 0) captured in the latch key.

**Capacity resolves through one seam.** `capacity.ts` resolves the budget once per operation for the exact summarization target (explicit pair → latest routed target → agent fallback, extracted into `resolveSummarizationTarget` so admission, latch keys, and the default summarizer share one resolution). Today the budget is the route's single `contextWindow` from `resolveModelInfo()`; no percentage, ceiling, or provider metadata is inferred. This module is the single point the WINDOW handoff retargets to its adapter-owned capacity snapshot.

**Admission failure is loud and never truncates.** A requested span that cannot be admitted throws a classified `admission-impossible` error; `compactRegion` never narrows or truncates a caller-chosen span to fake admission.

**Multi-pass when the largest balanced region cannot fit.** Pass selection takes the largest balanced head prefix whose priced messages fit the admission slack, never splitting a tool-call/result pair (`selectAdmittedCompactionRange`). Each pass summarizes exactly the span it replaces and lands its own checkpoint with full provenance; each pass must strictly reduce metered surface tokens (`no-progress` otherwise); the pass bound is `compactionRetries + 1` and reaching it fails loud (`pass-bound-exceeded`). Termination holds because every successful pass strictly shrinks a finite surface and an exhausted compactable head is a no-op.

**The deterministic latch bounds provider calls.** The latch key covers `replaceGeneration`, conversation and summarization targets, capacity identity, output reserve, safety margin, pass policy (`maxPasses`, effective `retainTokens`) and `PASS_POLICY_REVISION`, plus the failure classification. Deterministic classes: `admission-impossible`, `no-balanced-eligible-span`, `pass-bound-exceeded`, `no-progress`, `summary-not-smaller`, provider-confirmed `CONTEXT_WINDOW_EXCEEDED`, and request-size `INVALID_REQUEST` wording. The first failure records; one confirmation may follow — at most two summarization calls end in deterministic failure under one unchanged key — then the latch holds with zero further automatic calls while each pressure check reports the held cause. Ordinary assistant/tool/user appends never clear it; a durable replacement advances `replaceGeneration` and voids it; manual `compactNow` runs exactly one explicit probe without deleting the held key and re-latches immediately on reproduction. `TRANSPORT`, `SERVER`, `TIMEOUT`, `ABORTED`, rate-limit/quota, `terminated`, `fetch failed`, incomplete streams, and unclassified failures are transient and never latch. The latch is in-memory per session; the existing `maxOverflowRetries` budget keeps authorizing request-level retries after proven durable progress, and a held latch suppresses new summarization calls regardless of that budget.

## Alternatives considered

**Backoff between pressure attempts.** Rejected by the governing proposal: backoff slows the burn without bounding it; an unchanged deterministic key must stop issuing provider calls entirely.

**Skip admission for provider-confirmed overflow recovery.** Rejected: the summarization request must be proven regardless of which trigger caused it; without a disclosed capacity for the summarization route the operation fails loud naming the route.

**Duplicate the fixed-density estimator in compaction-basic.** Rejected: the estimator belongs to the token meter; admission prices the envelope through a new instance face of the same pure functions, keeping every figure in one vocabulary.

**Latch on the first deterministic failure.** Rejected: one confirmation probe distinguishes a reproducible class from a coincidental provider verdict while still bounding calls at two.

## Consequences

`compactRegion` on a route without disclosed capacity, or with a span that cannot fit, now fails loud where it previously sent the request; overflow recovery therefore requires the summarization route to disclose capacity (an explicit summarization pair with capacity keeps recovery working when the conversation route lacks it). Fixture windows in existing tests were rebalanced because the inherited 8192 reserve legitimately exceeds small test windows. `summary-not-smaller` and pass-bound exhaustion are now classified deterministic errors with the same messages as before. Full SWITCH preflight can consume `resolveCapacitySnapshot` and the same admission core when it lands.
