# Agent Note: Canonical image admission

Status: implemented

English | [中文](2026-08-20-canonical-image-admission.zh.md)

## Problem

Admission used to refuse any image above 2000px per side or 3.5 MiB, because an admitted image rides every later request and deployed routes reject oversized images. Refusal pushed the problem onto the user (downscale by hand, re-attach), and the byte size of admitted images was uncontrolled below the cap, so long sessions accumulated large request payloads. The unified image-pipeline design (PR #2676) needs a canonical, deterministic stored form as the basis for content-addressed dedup, stable request bytes, and a later provider-files upload path.

## Decision

`AttachmentStore.saveImage` resolves `SavedImageAttachment`: the durable `ref` describing stored bytes beside `source` facts of the submitted raster. The local store validates a wide source envelope (32 MiB, 100 MP, 16384px per side) and persists a deterministic canonical encoding: EXIF orientation baked in, metadata stripped, long edge downscaled to `canonicalMaxDimension` (default 2048px), palette PNG for alpha/PNG/GIF lineage and JPEG for photographic sources, stepping a fixed quality ladder (85/75/60/45) until `canonicalMaxBytes` (default 1 MiB) holds. An in-budget PNG/JPEG/WebP source passes through byte-identically only when it is single-frame and free of EXIF/XMP/IPTC metadata and non-default orientation, so equal originals keep one content address while location and device metadata never survive admission; GIF and every animated or metadata-carrying source re-encodes, and GIF always becomes the PNG of its first frame, pinning the first-frame meaning providers apply. Encoder parameters are fixed, not configurable — a parameter change would silently split the content-addressed space — so deployments choose only the source envelope and the canonical budget. `SourceImageInfo` records orientation-applied dimensions so source and stored raster share axes, and `validateImage` includes a canonical-encoding dry run so a validated batch can never be refused mid-write by the byte target. The canonical ref keeps the pre-existing field order (`mediaType`, `width`, `height`, `bytes`) so logged references stay byte-identical. `read_image` reports the on-disk dimensions and the coordinate multiplier whenever storage downscaled the file, naming per-axis multipliers when integer rounding makes the two ratios differ.

## Alternatives considered

- **Keep refusing oversized sources.** Simple, but hostile at exactly the moment a user pastes a normal screenshot from a HiDPI display, and it leaves admitted byte sizes unbounded below the cap.
- **Canonicalize at request time.** Re-encoding per request breaks byte-stable prefixes (provider context caching) and violates the design's rule that durable content is written once; the request layer only projects.
- **Make encoder quality configurable.** Two deployments with different quality would address the same source at different ids, silently defeating dedup; fixed parameters keep the space whole and an encoder upgrade re-addresses only future saves.
- **Pin a resize transcript snapshot.** A fixture embedding re-encoded bytes depends on cross-platform encoder byte-stability (libvips resize and palette quantization across arm64/x86), which is unverified in CI; the assembled snapshot instead pins the acceptance passthrough (2001x1 admitted byte-identically), and re-encode branches are pinned by package tests.

## Verification

Package tests cover passthrough identity, resize determinism and idempotence, GIF-to-PNG, alpha-to-PNG, JPEG ladder descent, ladder exhaustion refusal, encoder-fault mapping, and the store round-trip of a downscaled save. The read-image suite pins the downscale envelope text. The `read-image-dimension` keyless snapshot now pins the acceptance the 2000px cap used to refuse, using passthrough bytes so the fixture is platform-independent.

## Consequences

Ordinary large sources are admitted and bounded (≤2048px, ≤1 MiB by default), shrinking per-request image payload roughly 3.5x at the old cap and making the planned request-level budgets rarely reachable. Stored bytes may differ from the submitted file; consumers that map coordinates use the saved `source` facts, as `read_image` does. A cross-platform byte-stability check for the re-encode path remains open before any fixture may embed re-encoded bytes.
