# Agent Note: Policy versus maximum context windows and compaction admission

Status: proposed

English | [中文](2026-08-21-policy-versus-maximum-context-window-and-compaction-admission.zh.md)

## Problem

One long-running session grew to roughly 600k input tokens on a 1,000,000-token window model, then rerouted mid-session to a model whose installed pi-ai catalog entry resolves `contextWindow` 272000. The deployment's own local model metadata for that same route carries two distinct facts: `context_window` 272000 and `max_context_window` 872000. The harness vocabulary has one capacity per model, so only the first fact exists for it.

After the reroute, every automatic compaction failed. Of 270 `compaction/start` events in the session, 266 end with the identical error `pi-ai detected context overflow for model "gpt-5.6-sol"` between 2026-08-20T20:48:40+08:00 and 2026-08-21T06:51:27+08:00; one further close reports `terminated` and one `fetch failed`; the only two successful compactions predate the reroute and ran on the 1,000,000-token model. The largest observed successful request through the 272000-window route carries 615,520 input tokens, so the provider served inputs well above the catalog number while the harness kept calling them overflow.

The misclassification mechanism is in `packages/llm/llm-pi-ai/src/stream.ts`: `mapStopReason` feeds pi-ai's `isContextOverflow` the single resolved `contextWindow`, and that heuristic — written for providers that silently truncate input — treats any `stopReason: 'stop'` response with `usage.input + cacheRead > contextWindow` as overflow. The compaction summarizer replays the conversation prefix (system, tools, selected region) plus the compaction instruction through the same route and terminates in `stop`; above 272000 input every such successful response is reclassified as `CONTEXT_WINDOW_EXCEEDED`, so the compaction transaction can never close. Main tool-use requests terminate in `toolUse`, which the heuristic does not inspect, which is why the session itself kept working while compaction spun.

The repetition is structural. `maxOverflowRetries` gates only the `agent/request-error` recovery sequence in `packages/compaction/compaction-basic/src/index.ts`, and those request errors never fire because the main requests succeed. The `agent/pre-step` pressure handler catches each compaction failure with a warning and continues the turn, so the same deterministic failure re-ran before every following tool step: 260 of the 270 starts sit inside a single turn at a median interval of 85 seconds.

Two further gaps complete the picture. Region selection for overflow recovery calls `selectCompactableRange` with `retainTokens=0` — the largest balanced old region — and pressure selection retains a fraction of the same window, but neither proves that the resulting summarization request fits the summarization model's input budget; the summarizer's prefix-reusing design in `packages/compaction/compaction-basic/src/summarizer.ts` makes that request at least as large as the region it condenses. And because one `contextWindow` drives both the proactive pressure threshold (`resolveCompactSpec`) and the overflow verdict, no configuration can state "budget against 272000, this route carries up to 872000".

## Proposal

Freeze the following provider-neutral, model-neutral behavior. No rule names a provider, model, agent, or numeric window; every rule is stated in resolved capacities and measured tokens.

### Two capacities, two fields, one authority chain

`contextWindow` stays the policy window: the capacity the harness budgets against — the pressure threshold, the summarization admission budget, and the switch preflight. `maxContextWindow` is the hard window: the largest input the route can carry, and the only capacity overflow classification compares usage against.

Each field resolves through one authority chain: explicit deployment configuration (a `models` entry or `modelOverrides` field) over route-local capability metadata over the installed catalog entry over the route's `defaultContextWindow`. A single disclosed number serves both roles, so every model that discloses one capacity keeps today's behavior. No code path infers a larger maximum from a policy value. A deployment-local capability file is evidence for an override on that route in that deployment only; it is never promoted to a catalog fact for other deployments. Resolution validates positive integers and `maxContextWindow >= contextWindow` and fails loud at load naming the offending key.

### Canonical overflow detection

`CONTEXT_WINDOW_EXCEEDED` is returned exactly when the provider returns a recognized overflow error, or when a completed response proves the provider truncated it: `stop` with `usage.input + cacheRead > maxContextWindow`, or `length` with zero output and input filling the hard window. A successful response within the hard window is never reclassified as overflow for exceeding the policy window.

### Summarization admission budget

Region selection is bounded by the summarization model's own resolved policy window minus the priced prefix — system, tools, and compaction instruction — and a configured safety margin. When the balanced old region exceeds that budget, compaction proceeds in multiple balanced, bounded passes: each pass summarizes exactly the span it replaces and lands its own checkpoint, and the pass sequence converges under a declared bound on pass count. Compaction never summarizes a smaller span while replacing a larger one, never truncates the request and still replaces the full span, and fails loud instead. The per-pass summary-smaller check, tool-call/result pairing balance, and checkpoint provenance (`compaction/summary` with `shadowedRange`, `shadowedSeqs`, `shadowedTokenCount`, and `sourceEventSeqs`) are preserved unchanged.

### Deterministic failure latch

An automatic compaction failure whose cause is deterministic — the same classification repeated under an unchanged key of surface `replaceGeneration`, routed target, and effective policy — opens a latch: while the latch holds, further steps issue no new summarization provider calls. The latch clears when the generation, route, or policy changes, or when an operator intervenes through manual compaction or session maintenance. A latched session reports the held cause in diagnostics; the latch never silences the failure.

### Large-to-small switch preflight

Before committing a reroute whose resolved policy window is smaller than the session's projected next-request envelope — measured surface tokens plus the priced system prompt and tools — the switch either precompacts to a safe margin under the new window or fails loud and keeps the previous model. Session identity, log continuity, and Kernel semantics are unchanged: `agent-loop`, the `SessionEventMap`, and the durable `request/context` payload take no change (Kernel change = NONE); the preflight lives on the routing surface that stamps the next request's provider and model.

## Execution handoffs

**Window execution.** Extend the model-capacity vocabulary (`LlmModelContext`, the pi-ai catalog and profile materialization in `packages/llm/llm-pi-ai/src/catalog.ts`) with the two capacities and their authority chain; retarget overflow classification in `packages/llm/llm-pi-ai/src/stream.ts` and its call site in `adapter.ts` to the hard window; deliver llm-pi-ai tests, affected documentation, and a changeset.

**Compaction execution.** Add the summarization admission budget and bounded balanced multi-pass region selection to `packages/compaction/compaction-basic`; add the deterministic failure latch to the automatic pressure path; extend `compaction-loop-repro.spec.ts` with regression coverage for both.

**Switch execution.** Add the reroute preflight on the model-switch surface: precompact-before-commit or fail-loud keeping the previous model; change neither session identity nor Kernel semantics.

Each handoff is independently landable; none modifies production behavior outside its named surface, and none is implemented by this note.

## Alternatives considered

**Keep classifying any completed response above the policy window as overflow (status quo).** Rejected: it converts successful provider responses into compaction failures whenever policy and maximum differ, which is the observed incident.

**Raise the catalog `contextWindow` to the deployment maximum.** Rejected: the policy window is what pressure and admission must budget against; inflating it disables proactive compaction below the real maximum and moves every session onto overflow recovery.

**Publish the deployment-local maximum as a global catalog fact.** Rejected: a local capability cache proves capacity for its own route and deployment only; other deployments of the same model may enforce different maxima.

**Drop the cache-reusing prefix from the summarization call.** Rejected: sending a bare region discards tool context and KV-cache reuse; bounding the region against the admission budget keeps the prefix and still fits the request.

**Add per-step backoff to pressure compaction.** Rejected: backoff slows the burn without bounding it; a deterministic failure under unchanged state must stop issuing provider calls entirely.

**Fail the turn when pressure compaction fails.** Rejected: the main requests succeed; ending the turn would convert a working session into an outage.

## Acceptance criteria

- A 620,000-token session under a 272,000 policy window with an 872,000 hard window receives successful provider responses without an overflow verdict, pinned by an adapter-level test over finish mapping.
- Input beyond the hard window yields the canonical `CONTEXT_WINDOW_EXCEEDED` failure, both from provider error text and from the truncation-proofing usage heuristic.
- A summarization region exceeding the admission budget shrinks the replacement span through bounded passes or fails loud; the replaced span always equals the summarized span, and no truncated request ever replaces a full span.
- Under identical state — surface generation, route, and policy — with a deterministically failing summarizer, at least 20 consecutive tool steps issue a bounded number of summarization provider calls that does not grow linearly with steps, and none while latched.
- Switching a session grown on a 1,000,000-token window model at ~600k tokens to a 272,000-policy-window model either lands a precompaction to a safe margin before the reroute commits or refuses the switch, keeps the previous model, and states why; the session id is unchanged.
- Tool-call/result pairing balance, the per-pass summary-smaller check, and checkpoint provenance survive every new path; regression coverage extends `compaction-loop-repro.spec.ts`; llm-pi-ai catalog and stream tests plus a changeset accompany the window execution.

## Risks

**Two capacities double the misconfiguration surface.** Load-time validation and diagnostics must name the offending key and the violated relationship (`maxContextWindow >= contextWindow`) so a wrong pair fails at resolution, not mid-turn.

**Admission budgets can fragment history into many passes.** The declared pass bound plus the per-pass summary-smaller invariant keeps convergence observable; reaching the bound fails loud instead of looping.

**The latch can hide a transient cause.** The latch key contains exactly the inputs a deterministic retry could change — generation, route, policy — and latched diagnostics state the held cause so an operator can distinguish a latch from a silent skip.

**Preflight prices an estimate.** Token estimates drift from provider counts; the precompaction safety margin absorbs drift, and a misestimate still surfaces as the canonical overflow code at the provider boundary rather than as a misrouted session.

**Declared maxima can overstate real limits.** A route override is evidence-bound to its deployment; provider-confirmed overflow errors remain authoritative above any declared maximum.
