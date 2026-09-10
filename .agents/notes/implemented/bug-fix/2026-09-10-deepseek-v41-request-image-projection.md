# Agent Note: DeepSeek request images on the published token grid

Status: implemented

English | [中文](2026-09-10-deepseek-v41-request-image-projection.zh.md)

## Problem

The harness projected every DeepSeek request image under a 640,000 total-pixel budget, a value chosen for the retired V4 vision model and kept unchanged when the [token estimator moved to the `v41` calculator](2026-09-10-deepseek-image-token-calculator-v41.md). The current Flash model retains far more: it pads each edge to whole 14px patches, groups 3×3 patches into one token cell, and keeps the largest aspect-preserving grid whose token count `rows × (columns + 1) + 2` fits 1024. A square image keeps 1302×1302 pixels, a 16:9 image keeps 1708×966, and extreme aspect ratios keep up to about 1.8 million pixels. The 640,000-pixel projection therefore sent a 2000×2000 screenshot as 800×800, roughly 38% of the pixels the model would have used, and the estimator priced that reduced version at 422 tokens instead of the 994 the model charges for the full grid. The Vision guide's "about 1300×1300 total pixels" describes only the square case; the exact rule is the token grid.

Two smaller gaps sat beside it. The request version had no per-side cap: the provider rejects any image over 4096 pixels per side once a request carries 15 or more images, while normalization admits an 8192-pixel long edge, so a many-image session could fail on one thin image. The 1 MiB encoded-byte target was sized for 640,000-pixel outputs and would push a 1302×1302 photograph down the JPEG quality ladder.

## Decision

`ImageRequestPolicy` in `dsh-attachment` becomes a projection rule plus an optional per-side cap plus the byte target. The projection is a closed union: `pixel-budget` keeps the previous total-pixel geometry, and `token-grid` carries the patch size, downsampling ratio, and token cap of the provider grid. `request-projection.ts` owns the grid solver as `tokenGridProjection`, and `deepSeekImageTokens` in `llm-deepseek` reuses it for pricing, so the projection that sizes the request and the estimator that prices it are one solver. `requestImageDimensions` applies the projection, then the per-side cap, and keeps the source long edge exact while rounding the short edge; the local store resizes by the long edge only, so the encoded dimensions equal the predicted ones and the pricing handle text names what is actually sent. The provider pads the short edge to whole patches on its side.

DeepSeek routes resolve the grid when `imagePixelBudget` is omitted, a `pixel-budget` projection for a positive integer or the 512×512 `low` preset, a 4096-pixel per-side cap on every request image so the image count never changes a projection, and a 2 MiB byte target. The pi-ai route keeps its 2048×2048 pixel budget. The request-image transform version moves to `request-image-v6`, and the cache descriptor records the projection fields in a fixed order and the per-side cap, so no earlier cache entry or upload mapping is reused. Sources within the grid are sent at their own dimensions; small images are never enlarged because the provider scales up below 544×544 pixels itself.

## Alternatives considered

**Raise the pixel budget to 1302×1302.** A total-pixel budget is right only for squares: a 16:9 source would be sent at 1.69 million pixels when the grid keeps 1.65 million, and a 4:1 source when it keeps 1.59 million, while extreme ratios would lose detail the grid keeps. One rule that reproduces the provider removes the guesswork.

**Send the solver's exact dimensions with a fill resize.** The solved grid edges are whole patches and differ from the source aspect ratio by under one patch. Filling that box would distort the image slightly even though the provider does the same on its side; the issue requires the aspect ratio preserved, the padding on the provider side does not change the token count, and pricing reproduces the provider from the sent dimensions either way.

**A function-valued projection on the policy.** The cache and upload identity is a digest over serialized policy fields, so the projection has to be data.

**Keep the 1 MiB target.** The target is not a cap: an output over it is still sent at the smallest ladder quality. At 1302×1302 a JPEG photograph at quality 85 lands between 400 KB and 1.2 MB, so 2 MiB keeps most images at the top quality and lets more PNG screenshots pass through losslessly, while the inline base64 fallback still holds about seven such images under its 20 MiB bound.

## Consequences

A square source now reaches the model at up to 1302×1302 pixels and 994 tokens instead of 800×800 and 422, so image-heavy sessions reach compaction pressure sooner and the estimator matches provider usage for the sent version. Every existing request-image cache entry and DeepSeek Files API mapping is regenerated on the next request. Thin images keep their full grid until the per-side cap applies: an 8192×78 source costs 396 tokens under the grid but is sent as 4096×39. `llm-replay` does not project images, so keyless snapshots are unchanged, and the `llm-deepseek` adapter tests with mocked attachments pin the resolved policy and the projected handle text.
