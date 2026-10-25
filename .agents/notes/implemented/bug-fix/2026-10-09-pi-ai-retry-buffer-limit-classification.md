# Agent Note: Classify the gateway retry-buffer overrun as INVALID_REQUEST

Status: implemented

English | [中文](2026-10-09-pi-ai-retry-buffer-limit-classification.zh.md)

## Problem

A gateway edge that retries a failed upstream attempt must buffer the original request to resend it. When that buffered request outgrows the edge's buffer limit, the edge fails the exchange with `exceeded request buffer limit while retrying upstream` (the retry-phase sibling of the direct rejection `failed to buffer the request body: length limit exceeded`, which the adapter has classified as `INVALID_REQUEST` since the request-image-payload-bound fix). Envoy's reference router emits this 507 only while no upstream attempt is active — during retry backoff after an earlier upstream failure — and abandons buffering without it when an upstream request is live; the wording therefore always carries the edge's retry-phase context. pi-ai flattens a caught provider error to `error.message` before the terminal event, discarding the HTTP status, so `classifyPiAiError` matched no rule — no status digit, and a wording distinct from the classified sibling — and the failure surfaced as the catch-all `PI_AI_ERROR`. The same request-buffer family thus split into two routed codes depending on wording alone. Observed in production on a Feishu-channel agent whose model route crossed a gateway edge: the delivered notice read `PI_AI_ERROR: exceeded request buffer limit while retrying upstream`.

## Decision

`classifyPiAiError` extends the existing `INVALID_REQUEST` rule with the retry-phase wording. Both wordings describe the same gateway request-buffer family, so both route as `INVALID_REQUEST` — the conservative non-retry choice for this family. This is a routing decision, not a determinism claim: the overrun shows the request outgrew an edge buffer at retry-buffering time, not that the request is permanently invalid; whether an identical resend later succeeds depends on upstream state and edge buffer headroom. It is not retried because no supported local rule retried the catch-all either, and automatic replay of a request whose outcome history is unproven stays forbidden. Recovery semantics are unchanged for every class: `INVALID_REQUEST` stays outside the default retryable set (`EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`) and inside the forbidden-fallback set, so the reclassification routes the code without enabling any retry, provider fallback, or turn replay.

## Alternatives considered

- **Map the wording to `TRANSPORT` or `SERVER` so a composed retry policy can retry it.** Rejected: the text proves the edge hit its retry-buffer cap, not a pure wire transient, and automatic replay of the original request cannot be made side-effect-safe from this signal; the catch-all must also not become retryable (the reason the transport-truncation fix classified specific recoverable wordings instead). A future bounded-recovery design for this family needs its own evidence (captured status, request bytes, outcome history).
- **Bound or trim the assembled request in this fix.** Rejected: whether this production instance's request size actually drove the error is unverified — the HTTP status and request bytes were never captured, only the flattened text. Request-size compaction beyond the existing image-payload bound is separate design work that needs its own evidence.
- **Wait for pi-ai to forward the HTTP status or original error cause.** The durable fix, already marked `XXX(pi-ai upstream)` on the classifier; until pi-ai exposes the status or a capture hook, classification remains best-effort text matching.

## Consequences

- The retry-phase buffer wording now routes `INVALID_REQUEST` alongside its direct-rejection sibling; operators filtering on request-size failures see one code for the family.
- The routed code is a conservative family classification, not proof of permanent invalidity: a future bounded-recovery design must not treat this `INVALID_REQUEST` as evidence that an identical resend cannot succeed.
- Classification remains string-matching and wording-dependent: a gateway or pi-ai release that rewords the message silently falls back to `PI_AI_ERROR` until the pattern is updated.
- No recovery behavior changes for any error class; the reclassification is observable only in the routed code and downstream filters.
