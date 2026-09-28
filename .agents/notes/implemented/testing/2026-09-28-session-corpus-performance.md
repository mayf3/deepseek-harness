# Agent Note: Performance baselines for large Session corpora

Status: implemented

English | [中文](2026-09-28-session-corpus-performance.zh.md)

## Problem

Existing gates measure one long Session: [opening it](2026-09-04-session-open-performance-gate.md) or [continuing it](2026-09-06-backend-continuation-performance.md). Listing, content search, and fork scale with the whole corpus or with the source Session's length, and no gate covered a user with many long Sessions. A corpus of uniform small Sessions would understate the work, because real corpora are heavy-tailed.

## Decision

The [session-corpus benchmark](../../../../benchmarks/session-corpus/session-corpus.bench.ts) measures three Web Host endpoints over synthetic current-generation Zstandard corpora. No product implementation changes.

### Workload

On 2026-09-28, one developer's local DSH home held 1,650 Sessions in 88 project directories. Aggregate counts were extracted from the newest generation of each Session; no content, identity, or path left that machine. [corpus-shape.ts](../../../../benchmarks/session-corpus/corpus-shape.ts) records 22 upper-quantile anchors for three dimensions: logical events (compact delta rows expanded), decompressed bytes, and turns.

| Quantile | Events | Logical bytes | Turns |
|---|---:|---:|---:|
| p50 | 53 | 86,195 | 1 |
| p90 | 709 | 1,849,503 | 3 |
| p99 | 7,229 | 8,479,554 | 18 |
| max | 84,467 | 48,139,877 | 2,181 |

Rank `r` of an `n`-Session corpus takes the first anchor at or above quantile `(r + 1) / n`, so every quantile of the synthetic corpus is at least the measured one. All dimensions share the rank: a long Session is long in every dimension. At 1,000 Sessions this upper-step sampling adds 16% events and 14% bytes over the measured quantile function; coarser anchors added up to 40%.

Other measured aggregates also set the fixture: 19 Sessions per project directory, one subagent child per six Sessions (measured 288 of 1,650), a 20,000-character system prompt (the measured median largest event is 21.9 KB), 3.9 characters per streamed delta, and 1.6 events per Zstandard frame. Turns contain tool steps (assistant message, tool call, tool result) until the event target is reached; a secant search over payload characters then reaches the byte target from below. Text comes from a Zipf-distributed synthetic vocabulary. Its stored compression ratio is 2.8, below the measured 3.4, so the fixture stores more compressed bytes than the source corpus.

### Corpus construction

The seed worker authors one event body per anchor, compresses it once, and writes each Session as its own header frame followed by the anchor's body. Sessions sharing an anchor differ only in header identity, creation time, project directory, and parent link. Creation time is a fixed permutation of rank, so list order does not follow length. Events carry the fields that `Session.append` records, compact streams come from the production `AssistantStreamAccumulator`, and rows are encoded with the persistence package's `eventLines`. A verification worker replays each distinct body through `sessionQuery.readSession`.

The projection cache is part of the list endpoint: each cold row carries cached projection values. The seed folds each anchor once through the public `sessionProjectionCache.coldSnapshot` write-back. It then writes per-record documents for every Session with `serializeRecord`, rebinding identity to each header. Writing through the domain API costs one fsync per record, which took 89 s for 10,000 Sessions. The list worker requires every returned row to carry projections, so a storage layout change fails the benchmark instead of silently removing that work.

### Measured endpoints

Workers are compiled plain-Node processes, each started fresh against a seeded root. They compose the production Session store, projection registry, JSONL persistence, SQLite Session query with `openAt: first-search` on an in-memory index, JSON storage and projection cache, the Web projection set, AgentLoop, and the real `SessionController`. Transport lookups, upload registration, default model selection, and the Workspace registry are inert providers, because no measured path depends on them.

| Case | Corpus | Samples | Endpoint |
|---|---|---:|---|
| List | 1,000 and 5,000 | 5 | Host boot; first `session.list`; repeated `session.list` in the same process |
| Content search | 1,000 | 1 | First `session.search`, including the index build; a second query with a different term |
| Fork | 1,000 | 3 | `session.fork` return for rank midpoints of ten equal length strata, rank 990, and rank 999 |

Budgets enforce medians: list boot, first, and repeat; search first and repeat; fork median over strata, rank 990, and rank 999. One search sample is enforced because a cold index build takes about a minute on the reference machine. Reports include peak RSS and heap after the endpoint, but no memory budget applies.

## Calibration evidence

Reference expectations come from Apple M5 Pro, macOS arm64, Node 26.5, measured in isolated worker runs. They are scaled through the shared CI factor and headroom.

| Endpoint | Observed | Expectation |
|---|---|---:|
| List 1,000: boot / first / repeat | 237–271 / 311–358 / 254–293 ms | 300 / 400 / 300 ms |
| List 5,000: boot / first / repeat | 1,182–1,261 / 1,364–1,603 / 1,287–1,588 ms | 1,300 / 1,700 / 1,600 ms |
| Search 1,000: first / repeat | 57,006 / 1,046 ms | 60,000 / 1,100 ms |
| Fork: strata median / p99 / longest | 29–32 / 608–672 / 6,000–6,365 ms | 40 / 700 / 6,500 ms |

A 10,000-Session list took 3.2–5.4 s for the first call with 1.9 GB peak RSS; the extreme list case uses 5,000 Sessions to bound seeding time and disk use.

## Alternatives considered

- **Sanitized copies of real Sessions.** Rejected: benchmarks never use recorded user material.
- **Authoring every Session through `Session.append`.** Rejected: per-append validation and freezing, repeated per Session, made seeding take minutes.
- **Omitting the projection cache.** Rejected: rows would lack the values the Web list shows, which understates list work.
- **A separate CI job.** Rejected: benchmarks share one idle standard runner; the job timeout rises to 30 minutes instead.

## Consequences

The gate covers corpus-scale list, search, and fork costs that single-Session gates cannot see. It already shows that content search spends about a minute building its index on first use, that list cost grows linearly to about 1.5 s at 5,000 Sessions, and that forking the longest Session takes about 6 s. Seeding writes about 1.9 GB and adds roughly half a minute locally.

Exclusions: the corpus is current-generation only, although most real Sessions are stored in older generations, which list revision hashing and migration-on-read would add. Only 22 distinct bodies exist, so search indexes repeated text. Fork runs without Agent presets or Workspace attachment. Calls are in-process, without Typert transport or a browser. Filesystem caches are not evicted, so cold means a fresh process, not cold storage.
