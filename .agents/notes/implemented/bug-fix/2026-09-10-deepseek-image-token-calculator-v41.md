# Agent Note: DeepSeek image-token estimator on the v41 calculator

Status: implemented

English | [中文](2026-09-10-deepseek-image-token-calculator-v41.zh.md)

## Problem

`deepSeekImageTokens()` in `llm-deepseek` ported the provider's published image-token calculator in its `v4` configuration: a 384×384 scale-up floor, a 384-token cap, an 8:1 width clamp, a grid layout that adds a row for odd row counts and parity corrections, and a pad-to-4 alignment charged at its worst case. The provider's Vision guide now documents a different projection for the current Flash model: images below roughly 544×544 total pixels scale up, larger images scale down to roughly 1300×1300 total pixels, and one image costs at most 1024 tokens. The published calculator carries this as a `v41` configuration and the docs page instantiates that one. The old port therefore underpriced every retained image, an 800×800 request image by 73 tokens, so automatic compaction on image-dense sessions triggered late.

## Decision

`image-tokens.ts` is rewritten as a verbatim port of the `v41` configuration. The constants are a 14px patch, 3:1 per-axis downsampling, a 544×544 total-pixel floor, and a 1024-token cap. The grid formula is `rows × (cols + 1) + 2` with no odd-row extra row, no parity correction, and no even-row trimming in the solver. There is no alignment pad, so the estimate is exact rather than a worst-case upper bound, and there is no aspect-ratio clamp, so extreme aspect ratios reach the cap through the solver's one-row and one-column branches. The over-budget path is a single closed-form solve followed by the published assertion; the decrementing retry loop existed only for the odd-row layout. The provider's fixpoint iteration over the projected dimensions is unchanged.

The test vectors are re-pinned from the published calculator. The request-pricing tests, package README, and this note carry the new numbers; the pixel budget the harness applies before pricing (`DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET`, 640,000 total pixels) and the catalog model ids are unchanged.

## Alternatives considered

**Keep both configurations and select by model id.** The provider states that requests to the retired `deepseek-v4-flash-vision-exp` id are served by the current Flash model, so no reachable route prices under the old configuration. Two configurations would keep dead branches and their tests alive.

**Keep the generic class with the `isNLayout`, pad, and ratio-clamp switches.** A one-configuration port has fewer unreachable branches to exclude from coverage and states the shipped rule directly; a future provider revision changes this one module and its pinned vectors either way.

**Raise the harness pixel budget in the same change.** The provider now accepts roughly 1300×1300 total pixels per image, so the harness's 640,000-pixel projection discards detail the model could use. That is a request-content change with its own snapshot impact, separate from pricing what is actually sent.

## Consequences

Retained request images price higher, so image-dense DeepSeek sessions compact earlier and closer to the provider's real pressure. Under the harness's 640,000-pixel projection the ceiling for one image is 422 tokens at 800×800 rather than 349. The estimate no longer carries a three-token conservative margin; provider usage remains the authoritative anchor once a request completes. Sessions replayed through `llm-replay` use their fixture's `imageRequestTokens` and are unaffected.
