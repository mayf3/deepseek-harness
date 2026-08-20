# Agent Note: Unified image masters, request versions, and provider files

Status: implemented

English | [中文](2026-08-20-unified-image-request-pipeline.zh.md)

## Problem

Durable image history, provider resolution, inline request size, and remote file reuse have different limits. Treating an admitted image as the bytes sent on every later request forced one byte cap and one raster to serve all four concerns. Large but ordinary input was refused, clean 16-bit PNG could pass into history and fail at DeepSeek, repeated base64 expanded long requests, and a provider rejection repeated because the same durable image stayed in every future request. A model also had no stable way to crop a user upload that had no filesystem path.

## Decision

The image path has two explicit versions. The attachment backend owns a provider-independent durable master. Each image-capable model route owns a deterministic request policy, and the attachment backend derives and caches the exact request version from the master. Session history contains only the master reference; inline bytes and provider file ids remain transient request projections.

### Provider-independent master

Admission fully decodes each source under a configurable 32MiB, 100MP, and 16384px-per-side envelope. It applies EXIF orientation, removes metadata and color profiles, converts to 8-bit sRGB/sRGBA, and preserves aspect ratio while limiting the long edge to `masterMaxDimension`, 2048px by default. `sourceWidth` and `sourceHeight` record orientation-applied dimensions when preparation reduces the raster.

The master has an independent `masterMaxBytes` safety cap, 4MiB by default. Alpha is never flattened. A nearest-neighbour bounded sample classifies color complexity without averaging high-frequency pixels. Confirmed low-color input tries PNG, with palette encoding only when no alpha channel is present, followed by WebP qualities 85, 80, and 75. Other alpha input tries WebP at those qualities; other opaque input tries JPEG. Candidates execute in order and stop at the first result within the cap. Dimensions shrink only after every candidate at one size exceeds the cap. The source extension does not classify a PNG as low color. A clean, single-frame 8-bit sRGB/sRGBA PNG, JPEG, or WebP within both master limits passes through byte-identically and retains content-addressed deduplication. GIF, animation, metadata, orientation, 16-bit PNG, and incompatible color spaces force conversion. The source and a converted output are each fully decoded once; the output must match its format, dimensions, depth, color space, and alpha facts before its digest enters the reference.

Batch admission prepares and verifies every master once before publishing any member. Validation failure starts no writes. Publication uses those prepared bytes directly, so a large batch does not repeat full decoding and encoding during commit. A later storage failure returns no partial references; already published immutable objects may remain unreachable under the existing storage rule.

### Deterministic request versions

`AttachmentStore.readImageRequest` derives a request version under route-owned total-pixel and encoded-byte budgets. Scaling is `min(1, sqrt(maxPixels / (width * height)))`, with no enlargement, followed by inward integer rounding so the encoded raster never exceeds the total-pixel cap. DeepSeek V4 Flash Vision Exp uses 640,000 total pixels and 1MiB raw encoded bytes by default; low detail uses 512 by 512 total pixels. A 2048 by 1024 master projects to 1130 by 565 under the hard cap. Request encoding uses the same color branches, with PNG (palette only without alpha) then WebP 85 and 80 for low-color input, WebP 85 then 80 for other alpha input, and JPEG 85 then 80 for other opaque input. Each fallback runs only after the previous result exceeds 1MiB, and dimensions shrink only after both quality attempts exceed it. The same derivation is used by normal agent turns, direct `ctx.llm.stream` calls, compaction, and other auxiliary streams.

The `variantId` and cache path cover the master attachment id, transform version, route pixel and byte budgets, optional master-coordinate crop, and fixed encoder parameters. Cached output is fully decoded before reuse. DeepSeek Files and pi-ai inline base64 therefore use the same deterministic bytes for the same policy. Inline accounting uses the derived byte length after base64 expansion, not the master byte count. Equal in-process `variantId` calls share one transform and cache write; cancellation rejects only that waiter. `AttachmentStore.readImageRequests` preserves input order while the local implementation runs master and request transforms through one FIFO limiter. `imageCompressionConcurrency` is configurable from 1 through 8 and defaults to 2. Batch publication remains sequential after every master has been prepared.

Request-size offload is a deterministic oldest-first projection. DeepSeek defaults to 128MiB and 600 referenced images. Its removed prefix advances past successive 64MiB byte boundaries and in 20-image count quanta, so 129 one-megabyte images remove the oldest 65, retain 64MiB, and keep that prefix stable until total history passes 192MiB. Pi-ai retains a configurable base64 request bound. A text-only route receives deterministic attachment placeholders, including nested tool-result images, while append-only session history keeps the original references.

### Stable handles and master-coordinate crops

Every retained request image is preceded by its complete attachment id, actual request dimensions, and the preview-coordinate arguments for `read_image_region`. The tool accepts only an attachment already referenced by the calling session. It maps the supplied preview rectangle to the 2048px master with floor-at-origin and ceil-at-far-edge rounding, crops the master rather than the preview, and persists the result as a new attachment. The tool result contains the new `ImageBlock`, so model-visible output and the durable log remain equivalent.

### DeepSeek Files lifecycle

The direct `deepseek-official` adapter uploads every retained request version through the OpenAI-compatible Files API and sends only `file_id` content blocks. There is no inline fallback. The default catalog advertises `deepseek-v4-flash-vision-exp` as image-capable. Uploaded ids are indexed by endpoint and API-key scope plus `variantId`. Uploads request seven days by default and record the returned `expires_at`; a mapping with no more than one hour remaining is replaced without a preceding retrieve call. The index never stores the API key.

An upload is indexed only after the response returns a complete file object, matching byte count, and `expires_at`. A missing or inconsistent response leaves no local mapping, so a later request uploads again. A malformed upload index is an empty cache and is replaced on the next successful upload; filesystem I/O failures remain errors. If chat reports expired, deleted, missing, or invalid ids and names one or more ids used by the request, only those mappings are removed. A stale-file response without a specific id removes every mapping used by that chat attempt. The affected request bytes are uploaded again and chat is retried once. A second stale rejection clears the mappings identified by its response and returns the error without a third chat attempt. One upload quota error deletes the configured number of oldest harness-owned `dsh-` files and retries once. Public file operations expose list, retrieve, delete, one-variant release, and namespace-wide release. The client enforces the documented 128MiB upload limit, 32MiB chat-image limit, 10,000-file and 25GiB quotas, and one-hour to 30-day expiry range.

### Diagnostics

A 16-bit RGB or RGBA PNG is normal admitted input and converts to 8-bit sRGB/sRGBA. If local conversion fails, `read_image` names the path, detected 16-bit PNG, required canonical form, and manual conversion remedy. If DeepSeek rejects a normalized request version, the primary error names the attachment or display name, durable message and image position, normalized media type, 8-bit sRGB/sRGBA depth, dimensions, and provider message. An ambiguous multi-image rejection lists every candidate. The raw provider body remains the error cause rather than the only visible message.

Historical attachment objects that later disappear or fail integrity verification remain fail-loud. Durable quarantine and verified recovery require session events and are tracked by [Quarantine unreadable historical attachments](../../proposed/bug-fix/2026-08-20-attachment-read-quarantine.md).

## Alternatives considered

**Use one 1MiB canonical image for storage and requests.** This makes model resolution determine durable quality, reduces the source for later crops, and combines local storage, inline expansion, Files quota, and model pixels into one setting. Independent master and request policies keep those responsibilities explicit.

**Reject images above provider dimensions or at the encoding quality floor.** A provider limit is route-specific and future requests may use another model. Proportional master preparation and request projection accept ordinary large images while bounding each later representation.

**Treat PNG as a screenshot and reject 16-bit PNG.** File format does not reveal pixel complexity, and 16-bit RGB/RGBA is a convertible sample depth rather than an unsupported image type. Pixel sampling and post-conversion probes give the required facts.

**Keep DeepSeek data URLs.** Inline base64 repeats bytes on every request and caps usable image history by request-body size. Files API references reuse uploaded deterministic request bytes and provide explicit expiry and deletion.

**Trust a locally indexed file id indefinitely.** Remote expiry, deletion, and lost upload responses make local and provider state diverge. Response-directed invalidation and one re-upload recover without an unbounded retry loop; an ambiguous stale-file response must invalidate every file used by that attempt because it provides no safe exact target.

**Crop the request preview.** Repeated crops would compound the 640,000-pixel reduction and make coordinates depend on previous encodes. Mapping back to the master preserves the available local detail.

**Refuse text-only model selection after any image.** Durable history can outlive the model that first consumed it. Request-local placeholders keep the session usable without rewriting history.

**Remove one image whenever a request crosses its limit.** That changes an early request message after nearly every new upload. Quantized removed prefixes keep cache invalidation occasional while honoring the configured high bound.

## Verification

Package tests generate 16-bit RGB and RGBA PNG fixtures, prove 8-bit conversion and clean 8-bit passthrough, retain alpha under byte pressure, distinguish high-frequency and ordinary photos from low-color graphics, stop lazy encoding after the first fitting candidate, cover square and wide 640,000-pixel projections, enforce 1MiB request bytes, singleflight equal variants, bound transform concurrency, preserve cache and upload identity, map preview crops to the master, prepare batches once, reject inconsistent Files responses, refresh near-expiry ids without retrieve, recover once from single-id, multiple-id, and ambiguous stale responses, delete quota files, normalize provider diagnostics, project text-only history, and share normal/compaction request bytes. Keyless assembled snapshots cover the real tool schemas and image request path. A credentialed test uses the built-in `deepseek-official` route and its configured endpoint, never a custom provider entry.

## Consequences

Durable masters consume up to the independent local safety cap, while request caches and remote Files consume additional derived storage. Deterministic identities and singleflight make that work reusable across turns and sessions sharing the same DSH home. Two simultaneous transforms reduce batch latency while increasing peak RSS relative to serial execution; deployments with tighter memory can set the limit to one. Encoder or transform-version changes create new future identities without rewriting existing history. DeepSeek image requests now depend on Files API availability; bounded stale-id recovery handles inconsistent remote state, while a general Files outage remains a visible request failure. Missing or corrupt durable masters still require the separate quarantine design.
