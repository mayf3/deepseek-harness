# Agent Note: Shared persistence write coordinator

Status: implemented

English | [中文](2026-06-18-shared-persistence-write-coordinator.zh.md)

## Problem

The JSONL provider needs correctness-heavy write orchestration around its storage primitives: per-Session state, `session/created` adoption, prefix reads, write-behind control, per-id operation serialization, HMR seeding, and dispose drains. Keeping that lifecycle in the Service Definition prevents an out-of-tree provider from copying it. The removed first-party database provider demonstrated the duplication cost; the [JSONL-only persistence decision](../simplification/2026-08-30-jsonl-only-session-persistence.md) owns its removal.

## Decision

`dsh-session-persistence` exports a backend-agnostic `PersistenceCoordinator`. The JSONL provider composes one (`new PersistenceCoordinator(ctx, this)`), implements the small `PersistenceBackend` hook interface, and delegates its stateful public methods (`create`/`append`/`prepare`/`load`/`inspect`/`readFrom`) to it. Backend-owned metadata and revision listing bypass the coordinator.

Composition, not inheritance. The coordinator is a concrete class the backend holds, not a base class the backend extends. The risk that a coordinator makes unusual backends fight an inheritance hierarchy is avoided: a backend exposes only the hooks and cannot reach the coordinator's private orchestration state. A third-party backend MAY still implement the abstract service directly without the coordinator, including immutable logical inspection and the default preparation fallback through `load`.

The coordinator holds one lifecycle entry for each exact live `Session`: initialization plus a package-private write controller that owns pending events, a fixed batching deadline, the active write, failure retention, and the shared flush barrier. Each `session/event` enters that bounded write path, and `session/flush` bypasses the wait to observe quiescence. The [flush-controller simplification](../simplification/2026-07-23-collapse-persistence-flush-state.md) owns controller consolidation; the [bounded batching decision](2026-08-08-bounded-session-persistence-write-batching.md) owns scheduling cadence.

Creation borrows the exact `Session.events` snapshot as its persistence seed. `Session` has already detached, validated, and deeply frozen every event, and the snapshot array remains stable when later appends replace the cached view. The coordinator and its backend hooks only read this typed in-process value, so cloning the complete log again would duplicate the ownership work described by the [agent-scope runtime decision](2026-07-12-agent-scope-runtime-design.md#session-append-materialize-validate-commit-notify). Public persistence `append()` still snapshots caller-owned input at its API boundary.

Prepared-session suffixes and events admitted to the write-behind queue retain their existing copies. Those paths establish asynchronous queue ownership one suffix or event at a time and have no measured whole-log clone cost; removing their copies remains a separate ownership audit rather than part of creation-seed borrowing.

The coordinator retires a session from `session/disposed`: it waits for the controller's initialization and current flush, serializes a final drain, and removes the controller and owned per-id state only after success. A failure leaves the controller discoverable for backend teardown to retry. Settled per-id chain tails remove themselves only when they are still current, so a completion cannot erase a newer operation for the same id. Backend teardown unregisters write-path listeners, flushes every remaining controller, awaits per-id operations, and then closes the backend.

### The hook interface (`PersistenceBackend<TornMarker>`)

Six required durable primitives plus optional format-fusion, seek, empty-materialization, artifact, and lifecycle hooks form the only boundary between the coordinator and storage:

- `name` labels an aggregate disposal failure; `loadStored(id)` reads one already-current detached prefix; and `readStoredRevision(id)` returns its cheap source identity. The coordinator asserts ids and rejects a stored/live cwd mismatch before repair or state publication.
- `ensureCurrent?(id)` lets a backend publish any supported historical generation's current successor before a current read. `loadCurrentStored?(id)` fuses that operation with prefix decoding over one stable selected-generation snapshot; otherwise the coordinator calls `ensureCurrent` and `loadStored` in order. The same split exists for raw artifacts through `readCurrentRawStored?` and `readRawStored?`.
- `loadStoredFrom?(id, fromSeq)` is an optional seek-capable current suffix read. Sequential backends omit it and reuse the full current prefix.
- `appendBatch(meta, events, isMaterialized)` durably appends a contiguous batch and atomically performs lazy first materialization. `materializeHeader?(meta)` explicitly persists an empty resumable Session for lifecycle frontends such as [standard ACP automation controls](../feature/2026-08-22-standard-acp-automation-controls.md).
- `commitRepair(meta, tornMarker, closers)` makes crash repair durable by truncating the torn tail when present and appending closers when present. It need not be atomic: JSONL legitimately truncates then appends in two synced steps. Preparation and load commit truncation plus synthetic closers; live adoption commits truncation only.
- `list()` returns one header-only descriptor for every stored artifact; `locate?()` resolves a backend-owned artifact without I/O; and `close?()` releases backend resources after the coordinator's quiescence drain.

### The opaque torn marker

The single design choice that keeps the seam clean: the crash-repair "where is the torn tail" token is opaque to the coordinator. The coordinator computes the synthetic closers (it owns `interruptedTurnClosers` from `dsh-session`), but it only tests `tornMarker !== undefined` and passes the value straight back to `commitRepair`; it never inspects it. JSONL carries the byte offset to truncate to plus any complete events decoded from an incomplete final frame, while another provider may choose its own marker type. The coordinator therefore knows neither byte lengths nor frame recovery state.

## Testing

The shared `runPersistenceContract` proves that already-current JSONL `inspect` balances an interrupted logical view without changing storage or revisions before `prepare` or `load` commits recovery; a supported historical inspection first publishes its migrated and repaired current successor beside the unchanged source. `runCoordinatorContract` (`tests/coordinator-contract.ts`) covers adoption, HMR, collision, Session and provider disposal drains, and crash-tail repair through an in-memory reference and JSONL. `persistence.spec.ts`, `preparations.spec.ts`, and `write-behind.spec.ts` cover preparation reuse and reservation, bounded prepared-state eviction, fixed-window follow-up batches, live-controller cleanup, same-id chain-tail races, failed-batch retry, and close ordering. JSONL specs retain storage mechanics and the through-coordinator torn-tail case that exercises the opaque-marker branch.

## Alternatives considered

- **A base class the backends extend** — rejected for composition: a backend exposes only the hooks, cannot reach the coordinator's private orchestration state, and a third-party backend may still implement the abstract service directly without the coordinator at all.
- **Put historical formats in the coordinator or require two physical reads** — rejected because format framing, highest-generation selection, immutable successor publication, and stable-source decoding belong to the backend. Optional fused current reads preserve one coordinator lifecycle while letting JSONL classify or migrate and decode one exact snapshot; the ordinary hooks remain the fallback for other backends.

## Consequences

The coordinator adds one indirection, an opaque torn marker, detached Session-retirement tasks, and bounded prepared Session state, but centralizes correctness-heavy orchestration for the JSONL provider and future implementations. Session disposal remains an observe-only event, so the Session owner does not await persistence retirement; the coordinator contains failures, preserves pending events in the live controller, and makes provider teardown the quiescence boundary. Its hooks stay tied to current consumers: identity, adoption, collision checks, preparation, and immutable inspection share the serialized current-prefix path; materialization stays atomic inside `appendBatch`; and listing bypasses stateful orchestration. For already-current input, read models use `inspect` rather than `load`, so observing an open turn does not commit interruption closers; historical input first publishes a separate migrated and repaired successor. The [Session preparation decision](2026-08-05-session-preparation.md) owns reuse, reservation, and publication. A new provider implements storage primitives rather than copying the bounded write lifecycle.
