---
description: "The persisted session-projection cache for deployments and maintainers choosing, configuring, or debugging durable checkpoints, zero-I/O list reads, and accelerated cold projection folds."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-projection-cache

English | [中文](README.zh.md)

## Summary

`dsh-session-projection-cache` persists every registered projection unit's state as one versioned document per session in the `session_projcache` storage domain's `per-record` layout. A stored row is a disposable fold shortcut, never an authority: a zero-I/O listing may use it as a tentative hint, but the row may lag the log or overreach a later crash-repaired truncation. Exact opening and cold reads validate cached state against the supplied complete log and refold when a row no longer fits; the cache never reads session persistence itself. Three mandatory checkpoints — session creation, `turn/end`, and session disposal — plus configurable count and interval throttles keep records fresh enough for list prewarming and accelerated cold folds.

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

Mount this package beside the projection registry and the storage stack when clients should list projection values for cold sessions without loading their logs. Without it, consumers must obtain the log before they can reconstruct cold projection values.

### When to choose it

Choose it when a deployment restarts sessions and needs durable projection values for history lists, statistics, or goal snapshots. Skip it when projections serve only live sessions, or when the extra storage writes cost more than the saved projection work.

### Minimal configuration

Both throttle fields are required — flush cadence is a deployment choice with no universally correct value:

The cache opens its domain through the storage stack, so base mounts `storage`, `storage-json` (root `dshHomePath('storages')`), and `storage-domain` (`backend: json`) before it:

```yaml
- id: session-projection-cache
  name: '@deepseek-ai/dsh-session-projection-cache'
  config:
    writeEveryEvents: 200
    writeIntervalMs: 5000
```

| Field | Default | Meaning |
|---|---|---|
| `writeEveryEvents` | required | Committed events per session that force a durable checkpoint write between mandatory points |
| `writeIntervalMs` | required | Longest time a dirty checkpoint may stay unwritten between mandatory points |

The plugin injects `storageDomain`, `sessionProjections`, and `sessions`. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-session-projection-cache) is the exhaustive source for every accepted field and its JSDoc.

### How checkpoints are written

Three mandatory points always write: session creation persists the seed-derived cut, `turn/end` persists the value that listing reads want, and session disposal persists the final live cut. Between them, the configured count and interval throttles write as events accumulate. Every write atomically replaces the session's complete record through the domain write chain; a failure logs a warning and keeps the cache stale, and the next write self-heals.

### Reading cached values

`cachedSnapshot(meta)` synchronously serves client values from the storage domain's coherent in-memory table with zero I/O. It accepts only an identity-matching record and version- and schema-matching client keys, then returns a tentative `{ asOfSeq, values }` cut at the lowest served-row watermark; host-only rows are omitted. It returns `undefined` for an unknown id, unrelated lifecycle, absent or foreign record document, or no usable rows. The list carrier uses this value only to prewarm cells: an exact opening baseline replaces or clears it even when the cached sequence is higher.

`coldSnapshot(meta, events)` accepts the complete ordered log, validates every seeded row against that exact extent, folds any required events, and refreshes the record without consulting persistence. `hydratePrepared(session, meta, events)` performs the same validation for an unpublished prepared Session. If cached state is malformed or out of range, each path retries from `init(header)` over the full supplied log; corruption in the durable event stream still fails the retry instead of producing a partial snapshot.

### What the cache guarantees

At checkpoint commit time, the log leads and the cache follows: a live write flushes buffered Session events before storing the row, so that write cannot commit beyond the then-intact log. A later crash repair may truncate the log below an existing row, which is why cache-only values remain tentative and exact reads validate the supplied full log. Reads and writes share the storage domain's coherent in-memory state, which changes only after durability. Each record is bound to the Session header identity (`createdAt`, `cwd`), and each row is version- and schema-checked; unrelated or unusable cached data is discarded rather than migrated. The JSON backend stores each record at `<root>/session_projcache/sessions/<id>.json` in an owner-only directory tree.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the cache's durability and storage ownership; the observable behavior is covered in [Use this package](#use-this-package).

### Design concept

The cache is a fold shortcut over the projection registry's checkpoint face, stored in a `per-record` domain data table. Reads never bypass the domain's coherent memory; every background write is fail-soft; a `ver` mismatch discards rather than migrates a row; state must pass the live unit's `stateSchema`; writes replace one complete Session record through the lossless-JSON boundary; and exact reads treat the complete supplied log as authoritative.

### Read and write ownership

The cache stores one version-stamped document per Session in the `session_projcache` domain. It does not depend on a session-persistence backend, call `locate`, or inspect persistence directories. Callers own the exact log read and pass its immutable header and complete events into the cache; the cache owns validation, refolding, and fail-soft write-back.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `SessionProjectionCache` service, write-behind listeners, cache reads |
| [`src/spec.ts`](src/spec.ts) | The `session_projcache` domain spec and record identity types |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion (no runtime invariant; correctness is enforced at the write and read paths) |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the cache to the registry it checkpoints and the storage domain that holds its records.

- [Session projections subsystem](../../../docs/subsystems/session-projection.md) — the projection unit contract and drive semantics this cache checkpoints.
- [Session projection registry](../session-projection/README.md) — the `ctx.sessionProjections` service whose checkpoints this cache persists.
- [Storage subsystem](../../../docs/subsystems/storage.md) — the domain routing and backend behavior that store cache records.
- [Session package map](../README.md) — adjacent persistence, title, and telemetry packages.
- [Session-projection RFC](../../../.agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.md) — the persisted projection cache design rationale.

-----

<a id="model-experience"></a>
## Model Experience

None, as the persisted cache accelerates host-side reads of projection state and registers nothing model-facing.

#### KV Cache effect

None; the cache never assembles or sends provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define where the cache needs operational care. They are current package constraints, not a task backlog.

- **No eviction or retention surface** — records accumulate per session; pruning stored checkpoints is out-of-band maintenance, same stance as session persistence itself.
- **Interval throttle is per-session coarse** — the timer arms at the first dirty event after a clean write; a steady sub-threshold trickle writes once per interval, not a sliding window.
- **Zero-I/O values are tentative** — a cached row may trail current events or overreach a crash-repaired truncation; consumers must replace it with the exact opening baseline.
- **Callers supply cold logs** — the cache can validate and refold a complete log but never reads session persistence itself; a consumer that needs an exact cold snapshot owns that log read.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
