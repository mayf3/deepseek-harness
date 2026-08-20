# @deepseek-ai/dsh-attachment-local

English | [中文](README.zh.md)

The private local implementation of [`@deepseek-ai/dsh-attachment`](../attachment). Objects land at `<DSH_HOME>/attachments/v1/objects/<sha256-prefix>/<sha256>` and are addressed by an opaque `sha256:` id. Each process proves a home durable once by syncing every ancestor entry to the filesystem root, so a directory another process created but has not yet synced is never mistaken for a safe boundary. Writes then use a private staging directory, owner-only files, a synced temporary file, an atomic exclusive hard-link publish, and directory syncs on the publication path (POSIX; Windows relies on filesystem metadata journaling) so the reported reference survives a crash. Write admission fully decodes the raster against a wide source envelope — byte, total-pixel, and per-side caps (defaults 32MiB, 100MP, 16384px) — and then persists a deterministic canonical encoding instead of the submitted bytes: EXIF orientation is baked into pixels, metadata is stripped, the long edge is downscaled to the configured canonical target (default 2048px), sources with alpha or PNG/GIF lineage encode as palette PNG and photographic sources as JPEG, stepping down a fixed quality ladder (85/75/60/45) until the configured canonical byte target holds (default 1MiB). A PNG/JPEG/WebP source already inside the canonical budget passes through byte-identically only when it is a single frame and carries no EXIF/XMP/IPTC metadata and no non-default orientation, so equal originals keep deduplicating to one content address while location and device metadata never survive admission; GIF and every animated or metadata-carrying source re-encodes, and GIF always becomes the PNG of its first frame, pinning at admission the first-frame meaning providers apply. Encoder parameters are deliberately fixed rather than configurable, because a parameter change would silently split the content-addressed space; the deployment chooses only the source envelope and the canonical budget. An admitted image rides every later request of its session, so canonicalizing at admission is what bounds durable history without refusing ordinary large sources. `validateImage` runs the same policy including a canonical-encoding dry run, so a validated batch can never be refused mid-write by the byte target. Reads re-check the digest and logged metadata, and a later policy reduction does not make already-admitted history unreadable.

`DSH_HOME` resolves through the shared path policy: explicit config, `$DSH_HOME`, then `~/.dsh`. Session logs contain only the reference and verified metadata, never this host path. `readImage` forwards optional cancellation into the filesystem read, observes it around verification, and preserves it instead of wrapping it as `ATTACHMENT_READ_FAILED`.

## Model Experience

Indirectly, through durable replay of historical user images and structured model image output after restart and fork.

#### KV Cache effect

Canonicalization happens once at admission and is deterministic, so a stored image contributes identical request bytes on every later turn; nothing here re-encodes per request.

## Known Limitations and Deferred Work

- Objects are retained indefinitely; reference-aware garbage collection is deferred.
- The local backend assumes the host and provider adapter share this filesystem service.
- Animated GIF sources keep only their first frame; animation is outside the version-one image contract.
- The canonical encoder is pinned by the installed sharp/libvips build; an encoder upgrade re-addresses future saves of the same source while already-stored objects stay valid.
