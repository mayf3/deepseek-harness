# Agent Note: Classify the gateway retry-buffer overrun as INVALID_REQUEST

Status: implemented

English | [中文](2026-10-09-pi-ai-retry-buffer-limit-classification.zh.md)

## Problem

A gateway edge that retries a failed upstream attempt must buffer the original request to resend it. When that buffered request outgrows the edge's buffer limit, the edge fails the exchange with `exceeded request buffer limit while retrying upstream` (the retry-phase sibling of the direct rejection `failed to buffer the request body: length limit exceeded`, which the adapter has classified as `INVALID_REQUEST` since the request-image-payload-bound fix). pi-ai flattens a caught provider error to `error.message` before the terminal event, discarding the HTTP status, so `classifyPiAiError` matched no rule — no status digit, and a wording distinct from the classified sibling — and the failure surfaced as the catch-all `PI_AI_ERROR`. The same request-buffer family thus split into two routed codes depending on wording alone. Observed in production on a Feishu-channel agent whose model route crossed a gateway edge: the delivered notice read `PI_AI_ERROR: exceeded request buffer limit while retrying upstream`.

## Decision

`classifyPiAiError` extends the existing `INVALID_REQUEST` rule with the retry-phase wording. Both wordings describe the same mechanism — the request itself outgrew a gateway buffer tied to request size — so both route as `INVALID_REQUEST`: resending the same request re-hits the same cap, making the failure invalid rather than transient. Recovery semantics are unchanged for every class: `INVALID_REQUEST` stays outside the default retryable set (`EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`) and inside the forbidden-fallback set, so the reclassification routes the code without enabling any retry, provider fallback, or turn replay.

## Alternatives considered

- **Map the wording to `TRANSPORT` or `SERVER` so a composed retry policy can retry it.** Rejected: the overrun is a function of the request, not the wire; an identical resent request deterministically re-hits the same buffer cap, and the catch-all must not become retryable (the reason the transport-truncation fix classified specific recoverable wordings instead).
- **Bound or trim the assembled request in this fix.** Rejected: whether this production instance's request size actually drove the error is unverified — the HTTP status and request bytes were never captured, only the flattened text. Request-size compaction beyond the existing image-payload bound is separate design work that needs its own evidence.
- **Wait for pi-ai to forward the HTTP status or original error cause.** The durable fix, already marked `XXX(pi-ai upstream)` on the classifier; until pi-ai exposes the status or a capture hook, classification remains best-effort text matching.

## Consequences

- The retry-phase buffer wording now routes `INVALID_REQUEST` alongside its direct-rejection sibling; operators filtering on request-size failures see one code for the family.
- Classification remains string-matching and wording-dependent: a gateway or pi-ai release that rewords the message silently falls back to `PI_AI_ERROR` until the pattern is updated.
- No recovery behavior changes for any error class; the reclassification is observable only in the routed code and downstream filters.
