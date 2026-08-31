# Agent Note: Released Session formats migrate on body read through adjacent pure edges

Status: implemented

English | [中文](2026-08-31-released-session-format-migrations.zh.md)

## Problem

Session format v0 shipped in an alpha release, so a structural writer change can no longer treat existing JSONL as disposable pre-release state. The runtime also has several ways to read event bodies besides explicit resume: inspect, query, export, fork, continuation, suffix reads, and raw-artifact export. Migrating only one entry path would let callers observe different logical generations or fail only when a later writer reaches the old file.

Migration must retain the exact source path, bytes, and inode, including a torn physical tail, while giving every published format one unambiguous canonical filename. Plain JSONL and Zstandard are encoding choices for the same logical format and must not create parallel migration implementations.

## Decision

`SESSION_FORMAT_VERSION` is a monotonic current-writer integer. One profile-independent pure package owns each adjacent `vN -> vN+1` conversion. `@deepseek-ai/dsh-session-format` supplies only lossless snapshots, unique gap-free planning, header-only conversion, and whole-artifact composition; `@deepseek-ai/dsh-session-format-catalog` statically imports the complete chain independently of mounted Cordis plugins. Historical codecs and normalizers live in the named edge package, while current Session and persistence code accept only the latest logical types.

Each edge freezes strict source and target semantics, while its target physical codec remains vocabulary-neutral so ordinary event growth can stay within one format version. The catalog restores the final generation through the installed peer `@deepseek-ai/dsh-session` and its current `KNOWN_SESSION_EVENT_TYPES`, preventing a frozen historical edge from becoming the current vocabulary owner.

Every event-body operation crosses the persistence coordinator's per-Session serialization chain and completes provider-owned ensure-current work before current values escape. JSONL fuses highest-generation resolution, classification or migration, and current decoding over one physical snapshot; fallback backends retain separate `ensureCurrent` and current-read hooks. The six public reads are prepare, load, inspect, borrowSession, readFrom, and readRaw; cold append adoption uses the same body path. Header-only list and listSnapshots never migrate: they rescan each Session directory and return one descriptor for its numerically highest canonical generation, so a future, unsupported, or malformed highest file remains visible instead of silently falling back.

For `prepare`, `inspect`, and `borrowSession`, cancellation belongs to the observing call rather than shared preparation or migration. A cancelled observer stops waiting, while already-started work may finish for another inspector or later resume; durable publication is never rolled back to satisfy observer cancellation. Detached `readFrom` and `readRaw` operations instead pass cancellation into their serialized backend read.

The configured JSONL encoding owns one full suffix, `.jsonl` or `.jsonl.zstd`. Migration reads a stable exact source, decodes the recoverable logical prefix, composes every required edge in memory, applies current interrupted-turn repair, validates and syncs a same-directory temporary stage for only the final target, rechecks the source fingerprint, publishes that previously absent target without overwrite, syncs the namespace, and reopens it through the ordinary current reader before a Session is constructed. The source never moves or changes; only disposable temporary stages may be moved, linked, or removed.

Canonical filenames encode the physical format generation: v0 is `session.jsonl` or `session.jsonl.zstd`; every positive generation is lowercase `session.vN.jsonl` or `session.vN.jsonl.zstd`. Publication never renames, replaces, or deletes a committed generation path. If the target already exists, it is accepted only as a regular current-format file with exactly the expected bytes; any other target refuses. Lower generations remain for operator inspection or explicit copying, but normal runtime operations select the numerically highest canonical name and never use retained predecessors as automatic fallback, restore, or downgrade support.

The current-format fast path classifies the header from one stable source snapshot, invokes no historical converter or generation write, and passes that snapshot to current decoding without another file read. A validated current selection is cached for later opens in the same backend instance under the one-writer assumption, while listing deliberately rescans. Multiple edges leave the original generation unchanged and publish only the final target; intermediate versions exist only in memory. Same-process operations are serialized, and a source fingerprint recheck restarts the complete attempt when content changes. Cross-process writer fencing remains outside this guarantee.

The first edge, `@deepseek-ai/dsh-session-format-v0-to-v1`, is intentionally identity-shaped: aside from the version and bounded historical normalizations already accepted by v0, it preserves logical headers, events, sequence numbers, references, timestamps, payloads, and the configured compression choice. The exact `session.jsonl[.zstd]` source remains byte- and inode-identical, while the current writer encodes the new `session.v1.jsonl[.zstd]` successor. This exercises the complete publication lifecycle before a cardinality-changing format needs it.

## Consequences

Reading event bodies with a newer build may durably add a higher generation. The exact old generation remains available, but the runtime thereafter selects the highest canonical filename; retention does not promise that an older build can safely downgrade or that the newer build will fall back when the successor is corrupt. A read-only filesystem reports an actionable migration failure instead of returning an in-memory current view that differs from disk.

JSONL publication uses POSIX hard-link creation plus directory sync, and Windows uses no-overwrite `MoveFileExW` with write-through. A competing writer that wins target creation is accepted only when the committed bytes exactly match. One process-local writer per Session is the supported concurrency model. A future per-Session cross-process lock can close the remaining source-check-to-publication race without changing the format edge interface.

Retained generations are not a live-stream write-ahead log. A future optional WAL sidecar may preserve unfinished assistant streams across a hard crash. Explicit generation inspection or copying, retention tooling, compression conversion, and streamed whole-artifact transformation are separate features; automatic fallback and downgrade compatibility are not implied future work.

This note supersedes the continue-only persistence rule and the deferred-chain status in [Session log versioning](2026-08-10-session-log-version-mechanism.md). That note remains the authority for when to bump the version and for ordinary equal-version `ignorable` event behavior.

## Verification

Release verification ran the committed Session-format corpus gate over 152 versioned persisted-or-projected `session*.jsonl` fixtures under `snapshots/`, `packages/`, and `scripts/snapshots/python-sdk-single-exe/`. Fixture-only omitted envelopes and request-header tokens are materialized before the real static catalog; 150 fixtures reached the current v1 view through current restoration or historical migration. Released-v0 replay inputs remain suffixless, while fresh v1 writer outputs use `session.v1.jsonl` for a parent and `session.<ordinal>.v1.jsonl` for children; older role generations remain beside the selected highest file. The two exact alpha refusals were `snapshots/session/agent-instructions/session.jsonl`, whose projected compaction checkpoint has no matching start, and `snapshots/web/schedule-catalog/session.jsonl`, whose title source contradicts its citations. The continuing gate discovers the corpus dynamically and fails any refusal outside that closed manifest; separate assembled JSONL tests own exact physical-byte migration.

Current-head performance used three independent runs, each with 100 warmups and 600 alternating samples per case; a pooled 1,800-sample marginal estimator compared the immutable resolver with the same-commit dispatch-disabled baseline. Hot median/p95 deltas were raw small `-1.864%/-1.109%`, raw 100-turn `-0.711%/-0.445%`, Zstandard small `-0.880%/-5.025%`, and Zstandard 100-turn `-0.301%/-2.090%`, all within the five-percent regression ceiling. Cold enabled-path median/p95 costs were raw small `220.125/294.708 µs`, raw 100-turn `580.625/730.834 µs`, Zstandard small `248.042/960.083 µs`, and Zstandard 100-turn `636.291/1421.208 µs`. Repeated hot body reads performed zero directory scans; two listing calls performed two scans.

The assembled headless profile test stages `session.jsonl`, resumes it through the shipped composition, observes v1 before Session construction, verifies that the exact v0 bytes and inode remain while `session.v1.jsonl` appears, and proves the next append targets v1. JSONL contract tests exercise raw and Zstandard exclusive publication, torn-tail preservation, source changes, target collisions, future-highest refusal, current-selection caching, listing rescans, temporary cleanup, committed reopen, and current-format bypass.

## Alternatives considered

- **Migrate only on continuation** — leaves query, export, fork, and suffix consumers on old generations and duplicates restoration policy.
- **Return a migrated in-memory view without persisting** — lets one process observe state that does not match the highest committed generation and postpones failure until a later writer.
- **Persist every intermediate version** — consumes space and creates recovery states with no runtime consumer; only the source and final generation are durable.
- **Let mounted event-owner plugins register migrations** — makes historical readability deployment-dependent; the static catalog must work before feature plugins mount.
- **Reuse one filename for every current format and relocate its predecessor** — rejected because migration would move or overwrite committed evidence, require collision and retention rules, and make the filename disagree with the stored format. Canonical immutable generation names let discovery select the highest version directly.
