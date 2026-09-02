# Agent Note: Record each request's image projection in the session log

Status: proposed

English | [中文](2026-09-02-log-image-request-projection.zh.md)

## Problem

The repository invariant says model-visible ⟺ logged: anything that reaches a model request must be reconstructable from the session log. Request-size image offload currently breaks the reconstruction half of that invariant for historical requests.

Offload itself is deliberately transient: the durable surface keeps every original image reference, and each request replaces an oldest-first prefix of image occurrences with placeholder text at serialization time, per the [unified image request pipeline](../../implemented/feature/2026-08-20-unified-image-request-pipeline.md). The projection of a *future* request is a function of durable history plus live route configuration, and that half is healthy.

Reconstructing what a *past* request actually contained is not. Four decision inputs never enter the log:

1. **The representation actually dispatched.** A Files resolution failure rebuilds the request inline under the tighter `maxInlineRequestImageBytes` budget and its own removal quantum, offloading more images than file mode would, per the [Files inline fallback](../../implemented/bug-fix/2026-08-21-deepseek-files-inline-fallback.md). Which path ran is a per-request network outcome with no trace in the log.
2. **Exact derived request-version bytes.** The second projection stage uses the encoded byte length of each derived request version, which depends on the encoder pipeline, not on any logged fact; the log holds only the normalized attachment's byte count.
3. **Execution-world access paths.** `offloadedImageText` and `requestImageHandleText` embed the read-only path resolved for the current tool execution world into model-visible text. Resume or fork in another environment reconstructs different text than the request carried.
4. **Route budgets and quanta.** `maxRequestFilesBytes`, `maxImagesPerRequest`, both removal quanta, the inline watermark, and the per-model pixel/byte policy live only in composed connection configuration. The `request/header` snapshot records call config, system prompt, and tools; a configuration change silently changes every reprojection of old history.

Provider usage anchors token totals only and cannot recover the image set. The token meter's [route-priced estimate](../../implemented/feature/2026-08-24-route-priced-image-request-pressure.md) reproduces just the first projection stage and documents that the fallback budget is not reproduced and that access paths resolve at pricing time. So today no consumer — debugging, accounting reconciliation, or replay tooling — can pair a logged assistant response with the exact model-visible input that produced it.

## Proposal

Keep offload a transient projection and record its outcome: append one log-only event describing the image projection of each dispatched request whose outcome the log records.

**Event.** A new `SessionEventMap` member (working name `request/images`) carrying `{ turn, step }` plus the projection facts, appended within its step beside `request/header`. Like `request/header` it is log-only: derived message history and the durable surface are unchanged, and future requests still reproject from durable history and live configuration.

**Payload.** The representation dispatched (`file`, `inline`, or `text-only`) and, per image occurrence in request order: a retained occurrence's request-version width, height, and encoded byte count together with its model-visible handle text, or an offloaded occurrence's model-visible placeholder text. Substitution text is recorded verbatim so reconstruction does not depend on the stability of the text-building functions or on any execution environment. The vocabulary stays in `dsh-llm` terms so the pi-ai and DeepSeek adapters share one schema.

**Reporting channel.** The adapter that serialized the request owns these facts and reports them with the generation outcome, the same way `usage` travels to `assistant/message` today; the loop appends the event. The exact `LlmAdapter` result field is implementation detail for the follow-up PR.

**Attempt rule.** One event per dispatched request whose outcome enters the log. A pre-dispatch re-serialization (the file-to-inline fallback) records only the projection actually dispatched; the once-permitted stale-file retry records the retried dispatch, whose model-visible image set is unchanged because the fallback reuses the already derived request versions. Whether dispatches that end in a terminal provider failure also record is an open review question; the default is yes, so a failed request's content is as reconstructable as a successful one's.

**Format impact.** The event carries `ignorable: true` under the [session log version mechanism](../../implemented/architecture/2026-08-10-session-log-version-mechanism.md): a build that does not know the type still derives the surface correctly, and `SESSION_FORMAT_VERSION` stays unchanged because no structural format changes.

**Token accounting.** Unchanged. Provider usage remains the anchor for completed requests and the route-priced projection remains a synchronous estimate; the recorded event additionally enables exact post-hoc reconciliation of any historical request.

**Out of scope.** Copying budgets into `request/header` is unnecessary once outcomes are recorded and would change header equality semantics. Permanent image eviction — durably replacing old image occurrences on the message surface — remains a separate future decision requiring its own surface-replacement event; this event never changes the surface.

## Alternatives considered

**Pure derivation, with budgets logged into `request/header`.** Fixes only input 4. The dispatched representation and the exact derived byte lengths are runtime results no amount of logged configuration makes derivable, and access paths would still leak the environment into model-visible text. Making pure derivation true would require deleting the inline fallback and the exact second projection stage, trading away request deliverability for reconstructability.

**Log the full projected request body per request.** Complete but redundant: everything except the projection outcome is already derivable, and repeating the whole history per request grows the log quadratically. The outcome facts are the only new information.

**Permanently evict offloaded images from the durable surface.** Different semantics, not a cheaper encoding of the same one: it changes every future request, forfeits the property that images return when budgets rise or routes change, and conflates request-level omission with surface mutation — exactly what the issue requires keeping separate.

**Accept approximate reconstruction.** Leaves a model-visible divergence with zero trace: two replays of one log can disagree with what the model actually saw, and the fallback path makes the disagreement unbounded. This narrows the invariant instead of honoring it.

## Acceptance criteria

- From the log alone, every recorded model outcome in an image-bearing session pairs with the exact ordered image set — identity, request dimensions, encoded bytes — and the verbatim substitution texts its request carried, across file-mode requests, inline fallback, configuration changes, resume, fork, retry, and compaction.
- Replaying a log containing the event derives an unchanged message surface, and a build without the event type still accepts the log.
- Unit tests pin the event's append timing, attempt rule, and payload; keyless recorded-session snapshots cover offload in file mode and through the inline fallback; recovery tests cover resume and fork; both SDK expected outputs update if their projections surface the event.
- Review of this note files the follow-up implementation work items.

## Risks

- The payload vocabulary must stay provider-neutral; a schema that encodes DeepSeek transport concepts will strain the next adapter.
- Verbatim substitution text grows the log for every image-bearing request; the strings are short and per-occurrence, but image-dense sessions pay it on every step.
- Recording only the dispatched attempt hides earlier rejected dispatches; if those ever matter, the attempt rule needs revisiting rather than silent extension.
- The adapter-to-loop reporting channel is new surface on generation results; without a stated scope it invites other transient request facts into the log. This proposal covers image projection facts only.
