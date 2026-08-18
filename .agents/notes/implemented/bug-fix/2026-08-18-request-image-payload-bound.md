# Agent Note: Request-level image payload bound

Status: implemented

English | [中文](2026-08-18-request-image-payload-bound.zh.md)

## Problem

Every image in session history is base64-inlined into every model request by the pi-ai adapter, so a long session's request body grows monotonically with each admitted image. Gateways cap request-body size; once the accumulated payload crossed such a cap the request was rejected with 413 (`Failed to buffer the request body: length limit exceeded`), and because nothing bounds or trims the assembled request, every retry resent the same oversized body. The session was permanently unusable, and the failure text matched no `classifyPiAiError` rule, so it surfaced as the generic `PI_AI_ERROR`. Admission bounds (per image, per message) cannot prevent this: each image is individually admissible, and the sum still grows without bound. Two screenshots were enough to trigger it in production.

## Decision

The pi-ai provider profile carries `maxRequestImageBytes` (default `DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20MiB`, a positive integer, per route, changeable from cordis.yml and the `llm-pi-ai` settings section). At request conversion, `toPiContext` sums the base64 length of every image in history (derived from `ImageAttachmentRef.bytes` without reading data) and, while the sum exceeds the bound, replaces the oldest images with a fixed model-facing placeholder. The placeholder tells the model to read the file again when a path is available or ask the user to attach the image again. The most recent images are omitted last; an image larger than the bound is itself omitted. Offload locations use message and nested block indexes rather than object identity, so replaying the same JSON log produces the same request. Offloaded images are never read from the attachment store. `classifyPiAiError` classifies 413 and specific request-body-cap wording as `INVALID_REQUEST` (resending the same body cannot succeed). Four images admitted at the attachment store's 3.5MiB raw-image default occupy at most 18.67MiB after base64 expansion. The 20MiB request-image default therefore retains four such images and reserves the rest of a 32MiB request for system prompts, history, tools, and JSON. Deployments behind stricter gateways lower the value per route.

## Offload is conversion, not history

The placeholder is model-visible but not logged as a session event. It stays within the model-visible ⟺ logged invariant the same way the adapter's other serialization does (`(no output)` fallbacks, text-only folding): the offload locations are a pure function of the logged history and the route configuration, so the exact request remains reconstructable from the session log plus the composition. A logged elision event becomes necessary only when offload decisions gain non-deterministic inputs (for example live gateway feedback), which belongs to the deferred capability-metadata design.

## Alternatives considered

- **Fail the request with a clear error instead of offloading.** Keeps the model informed but leaves the session wedged: the user cannot remove images from durable history, so a hard failure at the bound is permanent. Offload keeps the session serviceable, which is the point of the fix.
- **Upload images once and reference them by URL / file id.** Removes the linear body growth entirely and is the right medium-term shape (providers and the internal gateway both document a Files path), but it introduces upload lifecycle management across providers and is far beyond a P0 hotfix.
- **Count the full request body, not only images.** Text and tools contribute little and their sizes are only known after full serialization per protocol; bounding the dominant term with explicit headroom is accurate enough for the failure being fixed and much simpler. Revisit inside the route-capability design.
- **Trim at admission instead.** Admission cannot see future accumulation; only the assembled request knows its total. Admission-side bounds (per-side dimension, bytes) remain as the first layer and are owned by [the dimension-limit note](2026-08-17-image-dimension-admission-limit.md).

## Related

- [Per-side image dimension admission limit](2026-08-17-image-dimension-admission-limit.md) — the admission-layer companion fix; together they close the two observed session-poisoning failures (400 dimension, 413 body size).

## Consequences

- An image-heavy long session keeps completing requests. The oldest images are omitted first; the most recent image is omitted only when it cannot fit within the bound.
- Crossing the bound rewrites an early message, so the provider prompt-cache prefix ends at the newly offloaded image until the offloaded prefix stabilizes.
- The bound counts base64 image payload only; deployments must keep it below their gateway's request-body cap with headroom, and the shipped default cannot know a private gateway's cap.
- Route capability metadata driving admission and assembly together (image count, per-image size, request size, provider token formulas) remains deferred design work tracked outside this fix.
