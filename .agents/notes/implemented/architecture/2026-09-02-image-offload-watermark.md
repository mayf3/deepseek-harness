# Agent Note: Durable image offload watermark

Status: implemented

English | [中文](2026-09-02-image-offload-watermark.zh.md)

## Problem

Request-size image offload was recomputed from scratch on every request. Each route collected every image occurrence on the derived surface, oldest first, and once the accumulated bytes exceeded its budget it rounded the excess up to a whole removal quantum and replaced that many oldest occurrences with placeholder text, per the [unified image request pipeline](../feature/2026-08-20-unified-image-request-pipeline.md). Nothing remembered where the previous request stopped; the prefix was stable only because the arithmetic over an append-only history repeated itself.

That stability failed wherever the arithmetic inputs moved. The [Files inline fallback](../../archived/bug-fix/2026-08-21-deepseek-files-inline-fallback.md) rebuilt a request under a 20 MiB inline budget with a 10 MiB quantum, offloading far more images for that one request, and the next request in file mode brought them back. The pi-ai route used a quantum of one byte, so its prefix moved on almost every request. Compaction lowered the total and returned previously offloaded images. A route switch moved every step boundary. Each move changed the model-visible prefix and invalidated the provider cache prefix.

The same recomputation broke the repository invariant that model-visible input is reconstructable from the session log. Which representation was dispatched, the exact derived request-version byte lengths, and the route budgets and quanta were runtime or configuration facts that never entered the log; `request/header` records call config, system prompt, and tools only. Provider usage anchors token totals and cannot recover the image set, and the [route-priced estimate](../../archived/feature/2026-08-24-route-priced-image-request-pressure.md) documented that it did not reproduce the fallback budget. No consumer could pair a logged assistant response with the image set its request carried.

## Decision

The offload point is a durable session fact: the core `image/offload` event records an image offload watermark that only advances, and the derived surface, every route, and the token meter read the offloaded set from it.

**Event.** `image/offload` carries `{ turn, step, watermark }`, where `watermark` is an `ImageOccurrencePosition`: the seq of the event carrying the last offloaded occurrence and its complete nested block path inside that event's content. Positions order by seq, then by path, so a newer event always lies after an older one regardless of surface replacements. `Session.deriveMessages()` and `Session.deriveEventMessage()` mark every occurrence positioned at or before the watermark `offloaded: true` on the `ImageBlock`; the marked copies are frozen and the durable event content is untouched. `Session.append` and seeding reject a malformed or non-advancing watermark and require its path to identify an image on the current surface. They also reject a logged message containing the request-only `offloaded` marker. The event is required-on-read because it changes the derived surface; adding it does not change the log envelope structure.

**Only advances.** The watermark never retreats when a budget grows, a route changes, or compaction lowers the total, so the model-visible prefix and the provider cache prefix move only forward. An occurrence below the watermark that compaction later shadows leaves the watermark valid, because the comparison is positional.

**Decision owned by `dsh-llm-retry`, budgets enforced by routes.** An image-capable route enforces an `LlmImageRequestBudget` (`representation`, `maxBytes`, `maxImages`, both quanta) over its retained occurrences' exact request-version bytes and reports the overflow as a failure; nothing plans an offload before dispatch. `dsh-llm-retry`, the recovery executor already on the `agent/request-error` waterfall, handles `IMAGE_OFFLOAD_REQUIRED` before any provider policy: it walks the surface in model request order, converts the reported count to the greatest durable position in that request-order prefix (a surface replacement can put a newer event before older ones, so the advance may offload additional occurrences but always covers the prefix), appends `image/offload`, and returns the `retry` action without spending the provider retry budget or logging `llm/retry`. The loop re-runs the step over the derived surface; the agent loop is unchanged.

**Adapters project, never decide.** Serialization renders every `offloaded` block as `offloadedImageText` with the currently resolved access path and prepares only retained occurrences. When the retained occurrences' exact request-version bytes still exceed the route budget, in file mode, under the inline fallback's tighter budget, or under the pi-ai bound, the adapter fails the attempt with `IMAGE_OFFLOAD_REQUIRED` and `LlmFailure.offloadImages` naming how many more oldest occurrences must be offloaded, computed with the shared `requiredImageOffload()`. When nothing remains to offload, `dsh-llm-retry` delegates and the failure reaches ordinary recovery.

**Token accounting.** `priceImages` receives surface `ImageBlock`s and prices an `offloaded` one as its placeholder text; the DeepSeek and replay pricing no longer reproduce any offload arithmetic. The meter folds `image/offload` into its replay state, prices the current surface under the current watermark and each usage anchor under the watermark its request was derived with. Provider usage remains the anchor for completed requests.

**Other consumers.** Compaction reconstructs each selected event through `Session.deriveEventMessage()`, which applies the same current watermark as `deriveMessages()`, before its direct `ctx.llm.stream` call. Resume, fork, and replay reproduce the surface from the log. Text-only routes keep their separate whole-history substitution.

## Alternatives considered

**Keep recomputing the offload point per request.** Stable only while the arithmetic inputs held still; the inline fallback, the pi-ai quantum, compaction, and route switches all moved the prefix, and no consumer could reconstruct a historical request's image set.

**Record each request's projection outcome as a log-only event.** Restores reconstructability but not stability: the recorded outcome is not a decision input, so every oscillation still happens and the log merely documents it, with two sources of truth for the offloaded set that can disagree.

**Log the full projected request body.** Everything except the offload decision is already derivable; repeating the history per request grows the log quadratically to record one position.

**Identify the watermark by attachment id or by occurrence count.** Attachment ids repeat for duplicate attachments, so the position is ambiguous; counts shift when compaction prunes earlier occurrences. A seq plus block path is unambiguous and survives pruning.

**Let each adapter append the event.** The adapter owns the budgets but not the session surface; a surface fact appended below the loop bypasses the session's derived history and lets two adapters define the surface differently. Adapters report the count they need instead.

**Plan the offload before dispatch, in the loop or in a plugin.** The loop knows the exact prepared route before deriving each request, so planning there never spends a failed attempt; but it puts a route-specific policy into the one component every profile shares, changes the documented step order, and bypasses the `agent/request-error` waterfall that context-overflow compaction and retry already use for the same repair-and-retry pattern. A pre-step plugin keeps the loop unchanged but cannot see the step's own messages or the first request's route, so the failure path stays necessary, and the plan needs every route to declare its budget on its model info. Handling only the failure costs one attempt per quantum crossing (64 MiB in DeepSeek file mode, 20 MiB on pi-ai) and matches the planned direction: routes will stop checking sizes locally, send every image, and the provider will report what it cannot cache, which is exactly a failure naming an offload point.

**Keep a transient extra offload for the inline fallback and exact-byte overflow.** Would have sent an unlogged projection in exactly the cases the invariant exists for; the failure-and-advance path costs one serialization attempt and keeps every dispatched request derivable from the log.

## Consequences

Offloaded images never return automatically when budgets grow, a larger route is selected, or compaction lowers the total; recovery is the read-only path in the placeholder, which the model uses deliberately. A Files outage or a temporary switch to a small-budget route advances the watermark permanently; both are accepted for the same reason. The route-local byte checks are provisional: once the provider reports uncacheable images itself, `requiredImageOffload()` and the route budgets go away while the event, the derivation, and the recovery branch stay as they are.

Every dispatched request's image set is determined by the log alone, across file mode, inline fallback, resume, fork, retry, and compaction, and the provider cache prefix no longer oscillates. The execution-world access path embedded in placeholder and handle text is still resolved at serialization time; that gap exists for retained images too and belongs to a separate decision about recording the execution-world mapping.

## Testing

`packages/llm/llm/tests/content.spec.ts` pins arbitrary-depth image traversal, represented bytes, projection, and the prefix count, including the 129-to-64 MiB quantum example. `packages/core/session/tests/image-offload.spec.ts` pins append and seed validation, exact current-surface image paths, rejection of persisted derived markers, strict advance, arbitrary-depth marking, frozen copies, cache rebuild, and scratch-replay equality. `packages/llm/llm-retry/tests/image-offload.spec.ts` pins the `IMAGE_OFFLOAD_REQUIRED` advance-and-retry path without a retry event, request-order counts after a surface replacement, and the exhausted case that delegates downstream. Compaction tests pin watermark application to direct summarization input. Adapter specs pin placeholder projection, prepared-only-retained reads, and the exact-byte failure with its count; `route-pricing.spec.ts` pins watermark pricing. The `inline-image-prompt` TypeScript SDK snapshot replays an authored `IMAGE_OFFLOAD_REQUIRED` attempt through the shipped profile and pins the advance and the retried request. The Python SDK notification test pins lossless forwarding of the new event and its nested watermark.
