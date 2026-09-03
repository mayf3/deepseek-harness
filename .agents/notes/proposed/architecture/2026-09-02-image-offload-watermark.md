# Agent Note: Durable image offload watermark

Status: proposed

English | [中文](2026-09-02-image-offload-watermark.zh.md)

## Problem

Request-size image offload is recomputed from scratch on every request. Each route collects every image occurrence on the derived surface, oldest first, and once the accumulated bytes exceed its budget it rounds the excess up to a whole removal quantum and replaces that many oldest occurrences with placeholder text, per the [unified image request pipeline](../../implemented/feature/2026-08-20-unified-image-request-pipeline.md). Under the DeepSeek defaults of a 128 MiB budget and a 64 MiB quantum, 129 one-mebibyte images offload the oldest 65, and that prefix holds until history passes 192 MiB. Nothing remembers where the previous request stopped; the prefix is stable only because the arithmetic over an append-only history repeats itself.

That stability fails wherever the arithmetic inputs move. The [Files inline fallback](../../implemented/bug-fix/2026-08-21-deepseek-files-inline-fallback.md) rebuilds a request under a 20 MiB inline budget with a 10 MiB quantum, offloading far more images for that one request, and the next request in file mode brings them back. The pi-ai route uses a quantum of one byte, so its prefix moves on almost every request. Compaction lowers the total and returns previously offloaded images. A route switch moves every step boundary. Each move changes the model-visible prefix and invalidates the provider cache prefix.

The same recomputation breaks the repository invariant that model-visible input is reconstructable from the session log. Which representation was dispatched, the exact derived request-version byte lengths, and the route budgets and quanta are runtime or configuration facts that never enter the log; `request/header` records call config, system prompt, and tools only. Provider usage anchors token totals and cannot recover the image set, and the [route-priced estimate](../../implemented/feature/2026-08-24-route-priced-image-request-pressure.md) documents that it does not reproduce the fallback budget. No consumer can pair a logged assistant response with the image set its request carried.

## Proposal

Make the offload point a durable session fact: an image offload watermark recorded as a surface-changing session event that only advances.

**Event.** A new required-on-read `SessionEventMap` member (working name `image/offload`) carrying `{ turn, step }` and the watermark position. It is a surface event in the same sense as the compaction events: derived history marks every image occurrence positioned before the watermark as offloaded, and every route projects a marked occurrence as its `offloadedImageText` placeholder. Occurrences at or after the watermark are retained. Adapters keep their existing placeholder rendering; the only change is that the offloaded set comes from the surface rather than from per-request arithmetic.

**Only advances.** A route whose budget is exceeded advances the watermark; a route with headroom leaves it alone. The watermark never retreats when a budget grows, a route changes, or compaction lowers the total, so the model-visible prefix and the provider cache prefix move only forward. Advancement keeps the existing count and byte quanta, so one advance still jumps to the next removal boundary rather than to the minimum that fits.

**Position by occurrence.** The watermark names the first retained image occurrence by the sequence number of the event that carries it and the block path inside that event's content, including nested tool-result content. It does not use attachment ids, which are content digests that repeat when one image is attached twice, and it does not count occurrences, which compaction pruning would shift.

**Appended before dispatch.** Like `request/header`, the event is appended inside its step before the request is sent, so the projection of every dispatched request is fully determined by the log at dispatch time. When the file-to-inline fallback needs a further advance, the adapter reports the requirement before the inline dispatch and the loop appends a second advance in the same step; the fallback still never sends an unlogged projection.

**Never ignorable.** The event changes the derived surface, so a build that does not know the type must refuse the log rather than replay it with images the model never saw. `SESSION_FORMAT_VERSION` stays unchanged because the log structure does not change.

**Decision owned by the loop.** `LlmRuntime` computes the watermark from budgets the route declares — representation, byte and count budgets, quanta — and appends the event; adapters declare budgets and report fallback requirements but do not decide the offloaded set. This makes the route-capability metadata seam that #2644 deferred a prerequisite of the implementation.

**Consequences for other consumers.** The token meter prices the exact offloaded set instead of reproducing first-stage arithmetic. Resume, fork, and replay reproduce the surface from the log. Compaction that prunes messages below the watermark leaves it valid because the position names a retained occurrence. Text-only routes keep their separate whole-history substitution and do not touch the watermark.

**Out of scope.** The execution-world access path embedded in placeholder and handle text is still resolved at serialization time; that gap exists for retained images too and belongs to a separate decision about recording the execution-world mapping. Recording per-request projection outcomes as a log-only event is unnecessary once the surface owns the offloaded set.

## Alternatives considered

**Keep recomputing the offload point per request (status quo).** Stable only while the arithmetic inputs hold still; the inline fallback, the pi-ai quantum, compaction, and route switches all move the prefix, and no consumer can reconstruct a historical request's image set. This is the state the issue asks to resolve.

**Record each request's projection outcome as a log-only event.** Restores reconstructability but not stability: the recorded outcome is not a decision input, so every oscillation above still happens and the log merely documents it. It also creates two sources of truth for the offloaded set, the surface arithmetic and the record, which can disagree.

**Log the full projected request body.** Everything except the offload decision is already derivable; repeating the history per request grows the log quadratically to record one position.

**Identify the watermark by attachment id or by occurrence count.** Attachment ids repeat for duplicate attachments, so the position is ambiguous; counts shift when compaction prunes earlier occurrences. A sequence number plus block path is unambiguous and survives pruning.

**Let each adapter append the event.** The adapter owns the budgets but not the session surface; a surface event appended below the loop bypasses the loop's ownership of derived history and would let two adapters define the surface differently.

## Acceptance criteria

- The watermark advances under file-mode budget pressure, inline fallback, and a route switch to a smaller budget, and never retreats after compaction, a budget increase, or a switch back.
- From the log alone, the offloaded set of every dispatched request is determined, including the fallback's second advance, across resume, fork, retry, and compaction.
- Replay, resume, and fork derive an identical surface, and a build without the event type refuses the log.
- Keyless recorded-session snapshots cover file-mode offload, inline-fallback advance, and compaction below the watermark; unit tests pin the position encoding, monotonicity, and pre-dispatch append timing; both SDK expected outputs update for the new surface event.
- The token meter's image pricing consumes the surface's offloaded set and the first-stage arithmetic reproduction is removed.

## Risks

- Offloaded images never return automatically when budgets grow; recovery is the read-only path in the placeholder, which the model must act on deliberately.
- The loop-side decision requires routes to declare budgets through a capability metadata seam that does not exist yet; the implementation cannot land without it.
- The fallback's pre-dispatch second advance adds an adapter-to-loop channel; without a stated scope it invites other transient request facts into surface events.
- The execution-world path in placeholder text remains unlogged; this proposal narrows the reconstruction gap to that one input rather than closing it.
