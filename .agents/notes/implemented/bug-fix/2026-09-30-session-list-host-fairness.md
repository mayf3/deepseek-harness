# Agent Note: Cooperative Session-list projection reads

Status: implemented

English | [中文](2026-09-30-session-list-host-fairness.zh.md)

## Problem

A Session list reads headers asynchronously, then computes cached projection summaries in a synchronous batch. Large plugin states make that batch block unrelated Host work even when each individual view is small. Real Host profiles identified repeated checkpoint decoding; CPU samples alone did not establish a speedup.

## Decision

[ApiSessionList](../../../../packages/api/session-controller/src/list.ts) yields to the Node event loop after each complete live or cold summary, including the final row. Cancellation is checked after each yield and rejects without partial results. Each summary remains synchronous. Live summaries still precede cold summaries before the stable activity sort; there is no cross-Session atomic snapshot promise. The [cached-row identity and precedence rules](../architecture/2026-09-19-projection-cache-listing-identity-and-cached-rows.md) remain unchanged.

The [projection-list benchmark](../../../../benchmarks/session-corpus/projection-list.bench.ts) complements the existing [corpus throughput cases](../testing/2026-09-28-session-corpus-performance.md). It uses the real built Session Controller, query engine, JSONL persistence, projection registry/cache, and storage domain. Only integrations outside the list path are inert. Each fresh child writes deterministic checksum-enabled Zstd headers and projection records, closes the writer, and mounts a fresh reader. No recorded user content is used.

| Workload | Sessions | Projection observation rows | Request records | Uncompressed state JSON |
|---|---:|---:|---:|---:|
| Modest | 50 | 4,925 | 641 | 1,813,852 bytes |
| Tail | 300 | 300,000 | 37,575 | 111,255,440 bytes |

Per-Session row counts repeat 50%, 75%, 100%, and 175% of the workload's base count, 100 or 1,000. Rows contain nested counters, text, tags, and request references; the wire view returns only summary counters. These observations are generated initial projection state, not fabricated durable Session events. Header-only logs suffice because listing must not read bodies.

Each child measures its first list and three separate repeats, including JSON serialization. Setup and explicit GC are outside timing. Complete results and their JSON remain reachable during post-GC heap/RSS sampling; peak RSS includes the entire process lifetime, including setup. The histogram starts before work and is drained after completion to include the final stall. A view-triggered immediate records queued Host work; this does not measure browser input, network transport, or paint.

At most one probe immediate is pending. Views re-arm it after each callback, so `maxViewsPerBatch === 1` protects the entire list, not just its first yield. The original synchronous loop fails with 300; a first-row-only yield fails with 299. Wall-clock delay is diagnostic rather than a scheduler-sensitive timing assertion. A coarse throughput bound uses the shared 500 ms reference allowance, time scale 2, and 1.25 headroom: 1,250 ms. Retained heap uses 240 MiB and only 1.25 headroom: 300 MiB.

## Measurement evidence

Local plain-Node 26.5.0 measurements on macOS arm64 use three fresh children per implementation. Repeat throughput takes each child's median, then the median across children. Repeated blocking takes each child's maximum event-loop delay, then the median across children. Heap uses each child's maximum post-GC heap over all four calls, then the median across children.

| Tail metric | Synchronous | Per-summary yield |
|---|---:|---:|
| Worst repeated event-loop delay | 159.12 ms | 4.66 ms |
| First list plus JSON | 214.59 ms | 215.25 ms |
| Repeated list plus JSON | 188.19 ms | 199.33 ms |
| Repeated process CPU | 225.29 ms | 237.18 ms |
| Retained heap | 187.55 MB | 186.46 MB |

The blocking metric falls 97.1%; this is not a throughput optimization. Repeated total time increases about 5.9%, while retained heap stays approximately constant. Raw samples below retain the child order; each bracket contains that child's three repeats. All times are milliseconds, rounded to three decimals.

| Observation | Synchronous samples | Per-summary yield samples |
|---|---|---|
| First list plus JSON | 214.590, 215.985, 209.984 | 215.254, 213.276, 226.746 |
| Repeated list plus JSON, child 1 | [195.159, 222.613, 188.618] | [198.127, 211.949, 204.683] |
| Repeated list plus JSON, child 2 | [188.193, 205.724, 184.953] | [186.018, 226.307, 199.334] |
| Repeated list plus JSON, child 3 | [187.546, 204.704, 187.872] | [186.525, 198.262, 211.093] |
| Event-loop maximum, child 1 | [152.437, 167.903, 141.558] | [3.228, 4.067, 2.636] |
| Event-loop maximum, child 2 | [143.393, 159.121, 141.296] | [2.879, 4.874, 3.564] |
| Event-loop maximum, child 3 | [137.232, 157.811, 142.475] | [3.478, 4.657, 3.164] |
| First process CPU | 300.073, 298.702, 300.600 | 293.328, 292.392, 302.004 |
| Repeated process CPU, child medians | 232.473, 224.689, 225.287 | 237.178, 230.197, 240.000 |
| Maximum retained heap, bytes | 187550048, 187549664, 186474808 | 187581360, 186462176, 186463408 |

## Alternatives considered

**Cache decoded projection states.** A trial improved repeated lists but retained an extra graph per stored row: about 189 MB became 346 MB, and first-read latency worsened. It also changed repeated schema-transform evaluation and required explicit alias ownership. Scheduling avoids these costs without weakening state or wire validation.

**Cache or truncate wire views.** Dynamic view choices can change between reads, and consumers require every currently available projection hint. Reuse or filtering would change behavior rather than remove batch blocking.

**Yield only once, or use a resolved Promise.** A first-row-only yield leaves the remaining batch synchronous; microtasks do not allow the event loop to service queued Host work. Bounded immediate probes reject both forms of lost fairness.

## Consequences

The Host can service other work between summaries without storing additional projection state. [Deterministic scheduling tests](../../../../packages/api/session-controller/tests/list-scheduling.host.spec.ts) pin middle and final yields, cancellation reasons, empty/omitted rows, stable ties, and attachment/removal/status interleavings. Existing Client mutation replay and cached-versus-sequenced precedence continue to reconcile in-flight lists.

A single large projection, final sorting, and response serialization remain synchronous. Concurrent lists can accumulate work in one event-loop turn, so the change is not a hard global stall bound. It deliberately trades a small amount of total listing time for Host responsiveness; it does not claim lower model latency, less parsing, or measured browser paint improvements.
