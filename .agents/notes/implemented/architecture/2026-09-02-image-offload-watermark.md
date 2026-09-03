# Agent Note: Durable image offload watermark

Status: implemented

English | [中文](2026-09-02-image-offload-watermark.zh.md)

## Problem

Request-size image offload was recomputed from scratch on every request. Each route collected every image occurrence on the derived surface, oldest first, and once the accumulated bytes exceeded its budget it rounded the excess up to a whole removal quantum and replaced that many oldest occurrences with placeholder text, per the [unified image request pipeline](../feature/2026-08-20-unified-image-request-pipeline.md). Nothing remembered where the previous request stopped; the prefix was stable only because the arithmetic over an append-only history repeated itself.

That stability failed wherever the arithmetic inputs moved. The [Files inline fallback](../bug-fix/2026-08-21-deepseek-files-inline-fallback.md) rebuilt a request under a 20 MiB inline budget with a 10 MiB quantum, offloading far more images for that one request, and the next request in file mode brought them back. The pi-ai route used a quantum of one byte, so its prefix moved on almost every request. Compaction lowered the total and returned previously offloaded images. A route switch moved every step boundary. Each move changed the model-visible prefix and invalidated the provider cache prefix.

The same recomputation broke the repository invariant that model-visible input is reconstructable from the session log. Which representation was dispatched, the exact derived request-version byte lengths, and the route budgets and quanta were runtime or configuration facts that never entered the log; `request/header` records call config, system prompt, and tools only. Provider usage anchors token totals and cannot recover the image set, and the [route-priced estimate](../feature/2026-08-24-route-priced-image-request-pressure.md) documented that it did not reproduce the fallback budget. No consumer could pair a logged assistant response with the image set its request carried.

## Decision

The offload point is a durable session fact: the core `image/offload` event records an image offload watermark that only advances, and the derived surface, every route, and the token meter read the offloaded set from it.

**Event.** `image/offload` carries `{ turn, step, watermark }`, where `watermark` is an `ImageOccurrencePosition`: the seq of the event carrying the last offloaded occurrence and its block path inside that event's content (the top-level block index, then the index inside a tool-result block). Positions order by seq, then by path, so a newer event always lies after an older one regardless of surface replacements. `Session.deriveMessages()` marks every occurrence positioned at or before the watermark `offloaded: true` on the `ImageBlock`; the marked copies are frozen and the durable event content is untouched. `Session.append` and seeding reject a watermark that is malformed, names an event outside the log, or does not advance strictly past the previous one; `session.imageOffloadWatermark()` folds the latest. The event is required-on-read because it changes the derived surface; `SESSION_FORMAT_VERSION` is unchanged because the log structure is not.

**Only advances.** The watermark never retreats when a budget grows, a route changes, or compaction lowers the total, so the model-visible prefix and the provider cache prefix move only forward. An occurrence below the watermark that compaction later shadows leaves the watermark valid, because the comparison is positional.

**Decision owned by the loop, budgets declared by routes.** An image-capable route declares an `LlmImageRequestBudget` (`representation`, `maxBytes`, `maxImages`, both quanta, and the request-version byte target) as `imageRequest` on its `LlmResolvedModelInfo`; `LlmRuntime` validates it and exposes it on `PreparedLlmCall`. After `request/header`, `buildRequest` collects the retained occurrences from the surface in log order, plans the advance with the pure `planImageOffload()` (represented bytes are the normalized count clamped to the version target and base64-expanded for inline routes, removed in whole quanta), appends the event, and only then derives the request messages. The DeepSeek adapter declares its file-mode budget; the pi-ai adapter declares its base64 bound; the replay adapter declares an optional `imageRequestMaxBytes` for keyless scenarios.

**Adapters project, never decide.** Serialization renders every `offloaded` block as `offloadedImageText` with the currently resolved access path and prepares only retained occurrences. When the retained occurrences' exact request-version bytes still exceed the route budget, in file mode, under the inline fallback's tighter budget, or under the pi-ai bound, the adapter fails the attempt with `IMAGE_OFFLOAD_REQUIRED` and `LlmFailure.offloadImages` naming how many more oldest occurrences must be offloaded, computed with `offloadedImagePrefixCount()`. The loop advances the watermark by that count and rebuilds the request before `agent/request-error` runs; when nothing remains to offload the failure reaches ordinary recovery.

**Token accounting.** `priceImages` receives surface `ImageBlock`s and prices an `offloaded` one as its placeholder text; the DeepSeek and replay pricing no longer reproduce any offload arithmetic. The meter folds `image/offload` into its replay state, prices the current surface under the current watermark and each usage anchor under the watermark its request was derived with. Provider usage remains the anchor for completed requests.

**Other consumers.** Compaction summarization and every other `ctx.llm.stream` caller derive from the same surface, so they read the watermark and never advance it. Resume, fork, and replay reproduce the surface from the log. Text-only routes keep their separate whole-history substitution.

## Alternatives considered

**Keep recomputing the offload point per request.** Stable only while the arithmetic inputs held still; the inline fallback, the pi-ai quantum, compaction, and route switches all moved the prefix, and no consumer could reconstruct a historical request's image set.

**Record each request's projection outcome as a log-only event.** Restores reconstructability but not stability: the recorded outcome is not a decision input, so every oscillation still happens and the log merely documents it, with two sources of truth for the offloaded set that can disagree.

**Log the full projected request body.** Everything except the offload decision is already derivable; repeating the history per request grows the log quadratically to record one position.

**Identify the watermark by attachment id or by occurrence count.** Attachment ids repeat for duplicate attachments, so the position is ambiguous; counts shift when compaction prunes earlier occurrences. A seq plus block path is unambiguous and survives pruning.

**Let each adapter append the event.** The adapter owns the budgets but not the session surface; a surface fact appended below the loop bypasses the loop's ownership of derived history and lets two adapters define the surface differently. Adapters report the count they need instead.

**Keep a transient extra offload for the inline fallback and exact-byte overflow.** Would have sent an unlogged projection in exactly the cases the invariant exists for; the failure-and-advance path costs one serialization attempt and keeps every dispatched request derivable from the log.

## Consequences

Offloaded images never return automatically when budgets grow, a larger route is selected, or compaction lowers the total; recovery is the read-only path in the placeholder, which the model uses deliberately. A Files outage or a temporary switch to a small-budget route advances the watermark permanently; both are accepted for the same reason.

Every dispatched request's image set is determined by the log alone, across file mode, inline fallback, resume, fork, retry, and compaction, and the provider cache prefix no longer oscillates. The execution-world access path embedded in placeholder and handle text is still resolved at serialization time; that gap exists for retained images too and belongs to a separate decision about recording the execution-world mapping.

## Testing

`packages/llm/llm/tests/content.spec.ts` pins the image walk, position ordering, represented bytes, marking, projection, and the watermark planner, including the 129-to-64 MiB quantum example. `packages/core/session/tests/image-offload.spec.ts` pins append and seed validation, strict advance, nested marking, frozen copies, cache rebuild, and scratch-replay equality. `packages/core/agent-loop/tests/image-offload.spec.ts` pins the pre-dispatch advance, the non-retreating watermark, the `IMAGE_OFFLOAD_REQUIRED` advance-and-rebuild path, and the exhausted case. Adapter specs pin placeholder projection, prepared-only-retained reads, and the exact-byte failure with its count; `route-pricing.spec.ts` pins watermark pricing; the replay adapter spec pins `imageRequestMaxBytes`. The `image-offload` ACP snapshot replays an authored six-frame session through the shipped profile under a replay route whose base64 budget admits three frames, and pins the `image/offload` watermark appended after the first `request/header` and the unchanged second turn.
