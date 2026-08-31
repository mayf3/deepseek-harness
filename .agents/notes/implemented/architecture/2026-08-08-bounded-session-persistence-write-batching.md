# Agent Note: Bounded session persistence write batching

Status: implemented

English | [中文](2026-08-08-bounded-session-persistence-write-batching.zh.md)

## Problem

One agent step can emit several durable events in a short interval: request metadata, one Assistant settlement, tool lifecycles, plugin facts, and execution boundaries. Scheduling a provider append as soon as an idle queue receives one event can therefore produce many small durable appends. Each JSONL append creates and syncs a Zstandard frame or raw suffix.

Assistant stream embedding reduces one high-volume event family, but write cadence remains a provider-neutral lifecycle concern for every other burst and for historical generations. The batching decision does not change event semantics or storage encoding.

### Quantified baseline

Released-v1 repository fixtures established the original logical volume. Decoding the packed `goal-multi-turn-actions` generation yielded 2,098 events, including 2,017 chunks (96.1%); unpacked chunk lines occupied 332,647 of 379,225 event bytes, while the packed file used 89,176 bytes and 182 rows. The packed `permission-policy-context` generation yielded 813 events, including 746 chunks (91.8%); unpacked chunk lines occupied 118,935 of 184,821 event bytes, while the packed file used 84,917 bytes and 123 rows. These deterministic historical measurements explain why v2 embeds streams, but they are not a production workload distribution or a current-format size claim.

JSONL writes one Zstandard frame and fsync per durable append batch. Runtime files do not record former append boundaries, so fixture row counts cannot honestly be presented as fsync counts.

The scheduling bound is deterministic. With an immediately resolving sink, the former immediate controller could issue one append for each event arriving after the previous append completed. A controller test admits 20 events 10 ms apart: the 200 ms fixed window hands all 20 to one append. This is a 20-to-1 reduction for that cadence, not a universal ratio. Sparse events, mandatory flushes, slow prior writes, and different arrival rates produce different batch sizes.

## Decision

The JSONL provider exposes `writeBatchMaxDelayMs`, a positive integer no greater than Node's timer limit. Its default is `200`. The provider resolves the value at load and passes it to `PersistenceCoordinator`; the coordinator remains the single owner of batching behavior.

Each live Session receives a package-private `SessionWriteBehind`. When its pending queue changes from empty to non-empty, the controller starts one fixed window. Later events join that batch without resetting the deadline: this is bounded coalescing, not debounce. When the deadline expires, the controller hands the complete pending prefix to the existing per-id serialization and `appendBatch` path. At most one write for a Session is active. Events admitted during that write form a new pending prefix with their own fixed deadline; if that deadline expires before the active write completes, the new prefix starts immediately after it.

`writeBatchMaxDelayMs` bounds only the controller's intentional batching wait. Event-loop scheduling, initialization, an earlier serialized operation, and backend I/O can delay durable completion, so the option is not a hard fsync or crash-loss SLA.

`session/flush` cancels any remaining wait and becomes a shared quiescence barrier. It drains the active attempt and every event admitted while the barrier is running before it resolves. Session retirement and backend disposal use that same barrier, so lifecycle teardown never waits for the batching timer. The checkpoint policy continues to place mandatory barriers before model requests and top-level tool side effects.

Every admitted event remains durable in its original order and representation. The controller copies each event on admission; batching removes or rewrites no sequence, timestamp, surface metadata, embedded Assistant stream, or storage record. JSONL can therefore encode more events in one append frame without changing the Session format.

A failed background append restores its complete batch before any newer pending events, reports the failure once, and pauses automatic retry. The next newly admitted event opens a fresh fixed window; an explicit flush, retirement, or disposal retries immediately and surfaces a repeated failure to its caller. This avoids a timer-driven failure loop while preserving the existing recoverable flush boundary.

This decision supersedes only the immediate scheduling cadence in [Collapse live persistence into one flush controller](../simplification/2026-07-23-collapse-persistence-flush-state.md). That note remains authoritative for one controller per live Session, retained failed batches, per-id serialization, retirement, and quiescent disposal. The [shared persistence coordinator](2026-06-18-shared-persistence-write-coordinator.md) remains the owner of the backend hook boundary.

## Alternatives considered

**Use one settlement per Assistant attempt instead of batching writes.** The [v2 Assistant stream decision](2026-09-01-v2-embedded-assistant-streams.md) provides that no-information-loss event model and reduces Assistant event cardinality. It does not replace bounded batching for other adjacent events, historical-generation publication, or providers with the same append interface.

**Write only at semantic checkpoints.** Rejected: it maximizes batching but makes the ordinary crash-loss window depend on a separately mounted policy. Bounded background writes preserve progress between checkpoints while mandatory flushes keep their stronger ordering contract.

**Debounce from the latest event.** Rejected: a continuously streaming response could postpone its first write indefinitely. A fixed window from the first pending event provides a real upper bound on intentional coalescing wait.

**Implement the timer inside JSONL.** Rejected: scheduling, failure retention, flush races, and teardown are provider-neutral lifecycle concerns that belong in `PersistenceCoordinator`; an out-of-tree provider can reuse the same behavior.

## Verification

The controller tests use a fake clock to prove the fixed, non-resetting 200 ms window; immediate and shared flush barriers; events admitted during a barrier; an over-budget tail behind an active write; ordered failure retention; paused automatic retry; and explicit retry of an overlapping background failure. Coordinator tests run the controller through Session notifications, retirement, collision reclamation, and teardown. The JSONL suite retains storage-format, recovery, and shared persistence-contract coverage.

## Consequences

High-frequency event bursts normally produce fewer durable append operations while preserving the exact admitted event sequence. The reduction depends on arrival rate and backend latency: a burst inside one 200 ms window becomes one batch, while mandatory flushes and sparse events can still produce small batches.

This decision does not cap pending event count or bytes behind a slow provider, and it does not reduce the decoded logical log. A demonstrated memory bound or logical-retention policy would require its own failure and replay contract rather than another hidden timer rule.

An admitted event can remain only in memory during the configured window, and then while scheduling or backend work is outstanding. Deployments choose a smaller value for a narrower ordinary loss window or a larger value for stronger batching. Explicit durability boundaries remain unchanged and bypass the wait.

The deep module gives the timer, active write, pending prefix, retry pause, and barrier one owner. `PersistenceCoordinator` retains initialization and identity serialization; the provider retains only durable storage primitives. Batching itself never changes `SESSION_FORMAT_VERSION`.
