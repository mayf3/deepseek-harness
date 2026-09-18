# Agent Note: Windows runtime signature cache

Status: implemented

English | [中文](2026-09-17-windows-runtime-signature-cache.zh.md)

## Problem

Windows packaging reconstructs unsigned native dependencies on each build. Signing unchanged Python and LibreOffice files repeats hardware-token and timestamp operations. Starting PowerShell for each public-key inspection also repeats process initialization.

## Decision

Cache complete signed runtime files by original content, public certificate, SignTool bytes, signing-script bytes and cache format. Keep valid vendor signatures. Restore a cache hit through a private staged copy only after checking the input record, signed-file digest, Windows trust, timestamp and configured certificate; reject invalid entries without automatic repair or hardware fallback. Publish complete entries atomically, and retain an existing valid entry when concurrent publishers collide.

Group public-key inspection into bounded batches of 32 files with at most four processes. Require one ordered result for every requested path and await every process in a failed batch. Preserve verification immediately after each hardware signature, before the next signing request.

The [primary-runtime decision](../feature/2026-09-14-desktop-primary-runtime.md) continues to own runtime contents, vendor-signature preservation and execution checks. The [release decision](../architecture/2026-08-25-electron-desktop-packaging-and-updates.md) continues to own release identity and signing. Neither is superseded. The cache must preserve their supervised preflight, per-user signing interlock, single-file hardware calls, signed inventory and final packaged-runtime validation.

## Alternatives considered

**Multi-file hardware signing.** The primary-runtime decision records that SignTool can continue after the first file fails. Reducing repeated hardware work through caching preserves the existing stop behavior.

**Detached signature extraction and attachment.** Complete-file caching avoids adding PE-signature manipulation to packaging. Its additional disk use is measurable and confined to build storage.

**Whole signed-runtime artifacts only.** They can also avoid extraction and copying, but require assembly and dependency-graph identities. Per-file caching can reuse unchanged native dependencies when application code or one dependency changes.

## Consequences

Repeated builds with unchanged native inputs avoid hardware calls for cached files while retaining preflight and final artifact signing. Changed content or signing policy misses the cache. Corrupt, incomplete, untrusted or incorrectly timestamped entries fail without replacing the target or retrying hardware. Concurrent publication and interrupted processes cannot expose incomplete entries or damage another build's files.

Six complete signed Windows x64 builds cover an empty signature cache, repeated inputs, application changes and one controlled native-file content change. Warm builds reduce hardware calls from 379 to 17 and elapsed time from 37:38 to 12:36–12:42 on the measured host, while final runtime checks pass. Download caches remain populated; the controlled file change tests invalidation, not a dependency-version upgrade. Installer execution and update qualification remain separate.

## Risks

The cache consumes local disk and depends on the build account controlling its files and records. It is not a distribution format for untrusted remote caches. Signature validation still depends on Windows trust services; cache hits do not authorize clearing a signing interlock or retrying a failed token operation. A timestamp-service failure can interrupt a cold build even after a successful preflight.
