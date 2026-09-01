---
description: "The durable session-storage seam for users and maintainers choosing a persistence backend, resuming sessions, or building a backend against the shared service contract."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-persistence

English | [中文](README.zh.md)

## Summary

`dsh-session-persistence` stores a session's event log durably, reloads it on resume, and lists stored sessions through the backend-neutral `ctx.sessionPersistence` service. The persisted unit is the existing `SessionEvent` log — there is no parallel stored message type. `SessionHeader.isSeeded` makes lineage visible to lightweight listing, while the exact `inheritedEventCount` accompanies every body-bearing storage read and prepared Session. A backend owns its storage, while the service owns append-only logs, contiguous sequence numbers, crash recovery that preserves an interrupted turn instead of truncating it, and durable writes that resolve only after the batch is safe. The shipped JSONL provider implements this service with one artifact per Session; third-party providers may implement the same contract without changing the loop or model.

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

Mount one persistence backend to make sessions durable. The backend registers itself as `ctx.sessionPersistence`; nothing else in the composition changes — the loop, resume, and replay all call the same service.

### Choosing a backend

The seam ships the [JSONL](../session-persistence-jsonl/README.md) backend. It stores one append-only current generation per Session and retains older version-named generations beside it; `locate(meta)` returns the absolute target path for the supplied logical header version. A third-party backend may implement the service directly; the [backend contract](#understand-the-implementation) below is what it must honor.

### What the service provides

With a backend mounted, you can store a session's events durably, reload the stored log, and list what is stored:

```text
await ctx.sessionPersistence.create(meta, inheritedEventCount) // cut required when meta.isSeeded
await ctx.sessionPersistence.ensureMaterialized(session)   // persist an empty resumable session
await ctx.sessionPersistence.append(id, events)            // durably persist a batch
const { meta, inheritedEventCount, events } = await ctx.sessionPersistence.load(id)
const listings = await ctx.sessionPersistence.list()       // header-only artifact descriptors
```

`append` resolves only after the batch is durable, so a resolved write survives an OS crash or power loss. Ordinary `create(meta, inheritedEventCount)` remains lazy; `meta.isSeeded: true` requires the sibling exact cut, while unseeded metadata may omit it and rejects a nonzero value. The first materializing batch for a seeded session must reach the complete inherited prefix, so storage never exposes metadata whose cut exceeds its log. A lifecycle frontend calls `ensureMaterialized` only when an empty session must itself appear in durable listing without inventing an event. `list` and `listSnapshots` read only independent headers and return one current, migration-required, unsupported, or malformed descriptor for the highest canonical generation in each Session directory. A descriptor's optional `storageId` comes from the backend-owned location rather than the header, so an unsupported or malformed artifact can still reserve its Session id. `load` returns an immutable balanced log and commits any needed crash recovery. For already-current storage, `inspect` keeps synthetic recovery in memory; a supported historical inspection first publishes a repaired current successor beside the unchanged source. `readFrom` accepts a `SessionLogOffset` and returns a detached `SessionEventSuffix` carrying that `fromSeq`, the unchanged inherited cut, and only stored events at or after the cut. A session's version-qualified artifact target (`locate`) resolves without filesystem I/O.

Cancellation on `prepare`, `inspect`, or `borrowSession` stops only that observer's wait. Shared cold preparation or historical migration that another observer can reuse may continue to completion; cancellation never rolls back a generation already entering durable publication. Detached `readFrom` and `readRaw` instead pass their cancellation signal to the serialized backend read.

### Resuming and crash recovery

Resume is `load` plus session preparation: the stored log comes back with its header lineage and exact inherited cut intact, so ownership checks do not infer the cut from a marker or the full restore length. A session that crashed mid-turn reloads with its interrupted final turn preserved and balanced: `load` appends synthetic `tool/result` and `turn/end {interrupted}` closers for unanswered calls instead of dropping the events — a single turn can be large, and those events were durably written before the crash. Only a never-fully-written torn tail fragment is discarded.

### Failures and recovery

A stored log the current build cannot faithfully interpret is refused with a direction-aware error, never misread. On a cold body read, the shipped JSONL backend selects the numerically highest canonical generation, refuses a future version even when an older readable file remains, and migrates a supported older generation through the static adjacent catalog. It publishes only the final current filename without overwriting the source or materializing intermediate versions. Header-only listing rescans and does not migrate. Catalog construction refuses a missing edge, committed-prefix corruption rejects as `SessionPersistenceCorruptionError`, equal-version unknown events require `ignorable: true`, and alpha historical migration refuses every unknown v0 event before publication. Retained predecessors are an operator escape hatch only: the service performs no automatic fallback and promises no downgrade compatibility. A `load` on an id still bound to a live session first flushes its snapshot and rejects while its turn is open; a cold load applies recovery.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the seam realizes durable storage and how backends plug in; the observable contract is covered in [Use this package](#use-this-package) and the generated [Cordis API](../../../docs/subsystems/persistence.md#cordis-surface).

### Design concept

The package is the Service Definition of a capability seam with two halves. The abstract `SessionPersistence` service is the public contract; a `PersistenceCoordinator` provides backend-neutral orchestration for buffering, serialization, materialization, repair, adoption, and quiescent disposal. The JSONL provider implements the small durable primitives for stored reads, append, repair, and listing; a third-party provider may reuse the same coordinator or implement the service directly.

### The invariants every backend honors

- **Append-only; a crashed turn is closed, not truncated.** Flushed events are never rewritten; `load` preserves an interrupted final turn and durably appends synthetic closers.
- **Contiguous `seq`.** A gap in the middle of the log rejects; `append`'s first `seq` must equal the stored next-seq.
- **Lossless JSON data.** Batches pass the shared one-pass lossless-JSON boundary; non-serializable payloads reject at the append site.
- **Durability.** `append` resolves only once the batch is durable.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: the abstract `SessionPersistence` service and re-exported metadata types |
| [`src/coordinator.ts`](src/coordinator.ts) | Shared write orchestration: batching, serialization, repair, adoption, disposal, format refusal |
| [`src/write-behind.ts`](src/write-behind.ts) | The per-session bounded write controller and flush barrier |
| [`src/preparations.ts`](src/preparations.ts) | Bounded retention of unpublished Session preparations for resume reuse |
| [`src/revision.ts`](src/revision.ts) | The branded opaque revision token |
| — | No runtime invariant companion is published; persistence correctness requires backend round-trip and crash-tail tests; this package exposes no continuously observable in-process relation. |

### The write path at a glance

Each `session/event` copies the event into its session's controller. The first pending event starts a fixed batching window; later events join without resetting its deadline. Expiry starts one durable append; events admitted during that write form a separately bounded follow-up batch. `session/flush` cancels the wait and drains through quiescence, so the loop uses it as the ordering and error-observation checkpoint before the next turn. A rejected background write retains its events and pauses automatic retry; a new event starts a fresh window, while explicit flush or backend teardown retries immediately.

### Stored-record compatibility

The coordinator and current Session code receive only the latest logical representation. `@deepseek-ai/dsh-session-format-catalog` supplies the profile-independent complete adjacent chain, and each named edge owns its historical header, physical records, payload inventory, normalizers, and target validator. Every body read completes backend-owned ensure-current work inside the per-Session serialization chain before current restoration. A backend may fuse that work with its current read; the generic fallback calls `ensureCurrent` and then the ordinary current hook. The [released-format lifecycle](../../../.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.md) owns immutable generation naming, highest-generation selection, and exclusive successor publication.

</details>
-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared durability model to the shipped backends and the decision evidence.

- [Session persistence subsystem](../../../docs/subsystems/persistence.md) — the full service contract, flush checkpoint, crash recovery, and generated Cordis API.
- [Session format chain](../session-format/README.md) — pure historical dispatch and adjacent migration composition.
- [JSONL persistence backend](../session-persistence-jsonl/README.md) — the shipped per-session-file backend.
- [Session checkpoint policy](../session-checkpoint-policy/README.md) — the plugin that flushes through this service at semantic boundaries.
- [Session package map](../README.md) — adjacent persistence, projection, title, and telemetry packages.

-----

<a id="model-experience"></a>
## Model Experience

### Resumed conversation history

#### What the model sees

The seam adds no prompt or schema. Resume restores stored surface events as message history; stored request headers reconstruct earlier calls, while the new loop composes the current system prompt, tools, and session prefix for its next request. Crash repair marks an assistant request without a durable call as `TOOL_NOT_STARTED`; a durable call without a result becomes `TOOL_OUTCOME_UNKNOWN`, whose text lets the model retry read-only or idempotent work but directs it to verify side effects or ask the user instead of retrying blindly.

#### Token effect

Zero tokens during ordinary persistence. Resume restores retained history cost and pays the current request envelope normally; each repaired call adds the quoted retained error text.

#### KV Cache effect

Persistence does not mutate live request prefixes. A resumed loop can reuse provider cache only when its reconstructed history, current envelope, and model route match; crash-repair results append without rewriting earlier history.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define where the seam's guarantees stop. They are current package constraints, not a task backlog.

- **No deletion or retention API** — pruning stored sessions is out-of-band backend maintenance.
- **`list()` is unpaginated and unfiltered** — it returns one header-only descriptor for every stored Session directory's highest canonical generation; fine for local stores, unindexed at scale.
- **Synthetic closers are the only crash story** — a backend must synthesize `tool/result`/`step/end`/`turn/end` closers on load; there is no partial-turn resume that continues an interrupted turn instead of closing it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
