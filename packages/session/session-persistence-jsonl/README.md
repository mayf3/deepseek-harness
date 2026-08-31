---
description: "The shipped JSONL session-persistence backend for deployments and maintainers choosing, configuring, or debugging per-session durable logs with optional Zstandard compression."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-persistence-jsonl

English | [中文](README.zh.md)

## Summary

`dsh-session-persistence-jsonl` stores each Session in canonical version-named JSONL generations whose ordinary writes append to the current file — checksummed Zstandard frames by default, raw newline-delimited lines when compression is disabled. Released v0 uses `session.jsonl[.zstd]`; positive versions use lowercase `session.vN.jsonl[.zstd]`. Migration publishes a previously absent successor beside the unchanged source and never renames, replaces, or deletes a committed generation path. The backend serves the same logical `SessionEvent` stream as any persistence backend, so physical naming, compression, historical decoding, migration, and crash recovery remain storage details. Choose it when consumers need per-session artifacts on disk: `locate(meta)` returns the version-qualified target, and raw generations are line-readable with `compression: 'none'`. A root directory is the one required configuration; durability, lazy materialization, and interrupted-turn recovery come with the backend.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this backend when a composition needs durable sessions backed by per-session files. The common path is explicit: load the session service, mount the backend, and give it a root directory.

### When to choose it

Choose this backend when consumers benefit from one artifact per session — navigation, external tooling, or a raw line-readable log. It is the sole first-party Session-persistence provider. The backend keeps sessions under a deployment-controlled root: project-local, shared, temporary, or centralized.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: /absolute/path/to/session-logs
```

`root` is required and has no default: a `process.cwd()` default would scatter session files as the process's cwd changes. An existing root must be a readable directory; an absent root is created on first materialization.

| Field | Default | Meaning |
|---|---|---|
| `root` | required | Root directory for all session files |
| `compression` | `'zstd'` | Physical encoding: `'zstd'` checksummed frames, or `'none'` newline-delimited UTF-8 text |
| `preparedSessionCacheSize` | `5` | Cold session preparations retained for resume reuse |
| `writeBatchMaxDelayMs` | `200` | Fixed live-event coalescing window, in milliseconds |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-session-persistence-jsonl) is the exhaustive source for every accepted field and its JSDoc.

### On-disk layout

Each Session gets a session-owned directory under a readable project directory. Every canonical generation starts with a physical header whose version equals its filename. Current v2 stores one physical row per durable event; the frozen v0 and v1 readers also understand their historical packed Assistant-delta rows. The format catalog translates every supported historical header and event representation before the persistence coordinator receives current logical values. Current storage records use the lossless provenance representation described below:

```text
<root>/
  --<normalized-cwd>--/          # readable project directory (or _no-cwd/)
    <encoded-id>/                # session-owned directory
      session.jsonl.zstd         # released v0, compressed root
      session.v1.jsonl.zstd      # released v1, compressed root
      session.v2.jsonl.zstd      # released v2, compressed root
      session.jsonl              # released v0, raw root
      session.v1.jsonl           # released v1, raw root
      session.v2.jsonl           # released v2, raw root; later versions use vN
```

Session ids are injectively escaped to one safe path segment before use (no traversal, no collision). The normalized cwd keeps the project directory readable for navigation; cwd strings that normalize alike share a project directory while session ids still select distinct session directories. `locate(meta)` performs no filesystem I/O and returns `{ kind: 'jsonl', path }` for `meta.version`: suffixless for v0 and `.vN` for every positive version. Listing instead reports the exact highest generation it found on disk.

### Durability and crash semantics

A Session is materialized lazily: `create(meta)` writes nothing, and the first `append` writes and `fsync`s the encoded header and first batch through no-overwrite publication at the current version's canonical filename. A created-but-never-appended Session therefore leaves nothing on disk unless a lifecycle consumer calls `ensureMaterialized`, which publishes one header frame without an event. Flushed current-generation events append lines or compressed frames; a caught write or sync failure rolls that file back to its prior length without replacing its path or inode. A body read of a supported historical generation reads one stable exact source, decodes its recoverable prefix, composes all required edges and current interrupted-turn repair in memory, writes and validates only the final target in a same-directory temporary file, rechecks the source fingerprint, then publishes the previously absent target without overwrite and syncs the namespace. POSIX links the temporary inode to the target; Windows moves the temporary file with write-through and no replacement. If another writer already published the target, the backend accepts it only when it is a regular current-format file with exactly the expected bytes. The source path, bytes, and inode remain unchanged, intermediate versions never reach disk, and the committed target is reopened through the current reader before a Session is constructed.

### Reading the logs

`inspect(id)` returns an immutable balanced view with its exact inherited cut; it does not commit crash recovery for an already-current generation. `readFrom(id, fromOffset)` accepts a `SessionLogOffset`, returns stored events at or past that offset, and retains the same cut beside the suffix; sequential media like JSONL parse the whole selected generation and skip forward. On its first cold body open, the backend scans the Session directory, selects the numerically highest canonical filename, refuses it when its version is newer than the build, or publishes the final current successor for a supported older version. A validated current selection is cached for later opens in the same backend instance under the one-writer assumption; `list` and `listSnapshots` always rescan and report the directory's highest generation. `readRaw` returns that selected generation and preserves its logical basename in `filename` (`session.jsonl` for v0 or `session.vN.jsonl` for v1+; `.zstd` is omitted because `content` is decoded). Retained lower generations are never automatic fallback, restore, or downgrade inputs. With `compression: 'none'`, every generation is newline-delimited text an external reader can consume directly; compressed generations require Zstandard decoding.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the physical encoding and write path; the observable contract is covered in [Use this package](#use-this-package).

### Design concept

The backend is a thin storage layer over the shared [PersistenceCoordinator](../session-persistence/README.md#understand-the-implementation): it loads stored records, appends batches, commits repairs, and delegates lifecycle orchestration to the coordinator. Its fused body-read hook carries one stable physical snapshot across generation classification or migration and current decoding, so the selected file is not read twice. After a current generation is validated, the backend caches its path for later same-process body opens; header listing deliberately bypasses that cache. Physical identity remains a file revision: device, inode, size, and nanosecond timestamps identify one generation and change after append or repair, which is what `listSnapshots` and retained-preparation validation use.

### Physical encoding

The default artifact is a standard concatenation of independent [Zstandard frames](../../../.agents/notes/implemented/architecture/2026-07-19-zstandard-jsonl-session-logs.md): one checksummed frame containing only the header line, then one checksummed frame per durable append batch, using Node's built-in Zstandard API at its default compression level (no level knob). Current v2 writes one event per row; `sourceEventSeqs` uses a lossless storage representation in which consecutive runs of at least three sequence numbers become `[start, end]` pairs, any other list stays verbatim, and reading expands the exact in-memory array. Listing reads and validates only the header frame. `compression: 'none'` keeps the same storage-form logical lines without frame compression. The configured suffix selects framing once; generation migration operates on decoded JSON values and uses the same publication algorithm for raw and compressed files. A root belongs to one encoding: startup discovery and targeted lookup reject the opposite suffix, and there is no compression migration, mixed-root fallback, or dual write. Frozen v0 and v1 codecs retain their packed-row decoders solely for historical generations.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, backend class, coordinator wiring |
| [`src/format.ts`](src/format.ts) | Log path derivation, header encoding, and current record scanning |
| [`src/generation.ts`](src/generation.ts) | Exact source reads, final-target staging, source recheck, and exclusive successor publication |
| [`src/zstd.ts`](src/zstd.ts) | Zstandard frame compression, decoding, and frame scanning |
| [`src/win32.ts`](src/win32.ts) | Windows write-through no-overwrite file and directory publication |
| — | No runtime invariant companion is published; persistence correctness requires backend round-trip and crash-tail tests; this package exposes no continuously observable in-process relation. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared persistence model to the sibling backend and the physical-format decisions.

- [Session persistence subsystem](../../../docs/subsystems/persistence.md) — backend-neutral service semantics and provider relationships.
- [Session persistence seam](../session-persistence/README.md) — the service contract this backend implements.
- [Released Session migrations](../../../.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.md) — adjacent-chain, immutable naming, and exclusive publication guarantees.
- [Project-session directory decision](../../../.agents/notes/implemented/architecture/2026-07-24-project-session-directories.md) — the layout tradeoff behind project and session directories.
- [Zstandard JSONL session logs](../../../.agents/notes/implemented/architecture/2026-07-19-zstandard-jsonl-session-logs.md) — the checksummed-frame encoding rationale.

-----

<a id="model-experience"></a>
## Model Experience

### Resumed conversation history

#### What the model sees

JSONL storage contributes no live prompt or schema. Loading restores stored surface history and preserves prior request headers for reconstruction; the new loop composes its current envelope. Recovery balances an assistant request without a durable call with `TOOL_NOT_STARTED`; a durable call without a result becomes `TOOL_OUTCOME_UNKNOWN`, which tells the model to retry only read-only or idempotent work and to verify possible side effects or ask the user. Embedded Assistant streams and log-only attempts do not duplicate messages.

#### Token effect

Zero live-request tokens. A resumed agent pays for retained history and its current envelope, plus the quoted repair result for each interrupted call.

#### KV Cache effect

JSONL storage does not mutate live request prefixes. A resumed loop can reuse provider cache only when its reconstructed history, current envelope, and model route match; crash-repair results append.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when this backend is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **Only the configured encoding loads** — supported older Session formats migrate within that encoding; changing compression still requires a separate or fresh root.
- **The flat-file storage layout does not load** — use a separate root or move pre-release artifacts into the project/session directory layout before loading.
- **Compressed files are not directly line-readable** — use the backend to load them, or select `compression: 'none'` before writing a fresh root when external line readers are required.
- **Nothing deletes session generations** — every canonical generation accumulates under `root` until removed externally; the seam has no deletion API and never falls back from the numerically highest filename to an older one.
- **Retention is not downgrade support** — predecessor files preserve exact evidence and permit explicit operator copying or inspection, but this build does not restore them automatically and makes no promise that an older binary can safely reopen a directory after a successor exists.
- **One live writer per session** — append, repair, and migration are coordinated only inside the owning backend instance; cross-process writer fencing requires a future per-session lock.
- **Publication requires no-overwrite filesystem primitives** — POSIX first materialization and successor publication use `link()` plus parent-directory `fsync`; Windows uses write-through moves that refuse an existing destination. Temporary stages may move or unlink, but committed generation paths do not.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
