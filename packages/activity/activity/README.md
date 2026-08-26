---
description: "The streaming-output observation contract (ctx.activities): open/append/end handles, non-consuming offset reads, owner fencing, and the shared pull pump for producers and consumers of live activity output."
kind: "package-reference"
---

# @deepseek-ai/dsh-activity

English | [中文](README.zh.md)

## Summary

`dsh-activity` lets a long-running producer publish live output and status once, and any number of independent consumers read it without stealing bytes from the model: reads are non-consuming, addressed by absolute UTF-8 byte offsets that survive eviction, and fenced to the owning session. The registry is a pure observation plane — it starts nothing, cancels nothing, and is invisible to the model, so producers keep their execution resources and their existing model-facing surfaces. This package ships the contract only; load [`dsh-activity-local`](../activity-local/README.md) to get a working registry, and without one `ctx.activities` does not exist and observation silently degrades to none.

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

Use this package when you write a producer that mirrors live work, or a consumer that renders it; the composition mounts an implementation row (`@deepseek-ai/dsh-activity-local`), never this contract package directly.

### Producing an activity

`open(spec): ActivityHandle` validates the kind, label, and exact live owner, then atomically registers the record and returns the producer face: synchronous `append(text, { channel?, gapBefore? })`, `updateDetail(detail)`, and first-wins `end(outcome)`. After `end` — including a teardown force-end — `append` and `updateDetail` log and drop instead of throwing, so a producer's trailing flush cannot break its own teardown. Producer plugins extend `ActivityKindMap` with their opaque id namespace and may link an activity to its tool call and background job through `ActivityCorrelation`. Access the registry with `ctx.get('activities')` and contain every observation failure: the plane is optional, and the observed work must never depend on it.

### Consuming activities

`get(id, caller?)` and `list(caller?)` return fresh snapshots; listing includes only caller-owned and unowned activities, and predictable ids make that fence the boundary. `read(id, from, caller?)` returns the retained chunks overlapping `[from, total)` plus the resume offset, without consuming anything; a reader below the oldest retained byte gets `lossy: true`, never an error. `onActivitiesChanged(listener)` observes visible-set changes so consumers re-read rather than accumulate deltas, and `onOutput(listener)` signals stream advancement carrying only the id; both deliver owner-relative and contain every listener.

### Pumping a substrate

`pumpActivityOutput(handle, sources, { pollMs, done })` is the shared pump for producers whose substrate is a non-consuming offset reader (the subprocess `readFrom(fromByte)` family): it copies labeled deltas at a bounded cadence, marks a lossy source read `gapBefore`, and drains once more after `done` settles without ever calling `end()` itself.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package holds the abstract `ActivityRegistry` service (a direct mount throws, naming an implementation to load), the vocabulary types, the branded `ActivityId`, the pump, and the invariant companion. Offsets are absolute so an observer's cursor never depends on what other observers did, and eviction moves only the earliest retained byte — the lossy flag is how a late reader learns the head is gone.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Abstract `ActivityRegistry` service and the direct-mount guard |
| [`src/types.ts`](src/types.ts) | Vocabulary: kinds, snapshots, handles, reads, listeners |
| [`src/brand.ts`](src/brand.ts) | Branded `ActivityId` (browser-safe leaf) |
| [`src/pump.ts`](src/pump.ts) | `pumpActivityOutput` pull-substrate pump |
| [`src/invariant.ts`](src/invariant.ts) | Snapshot invariants installed on the change feed |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-activity-local`](../activity-local/README.md) — the in-memory implementation and its retention config.
- [docs/subsystems/activity.md](../../../docs/subsystems/activity.md) — the subsystem reference: offsets, retention, listener delivery.
- [`dsh-api-activity-controller`](../../api/activity-controller/README.md) — the Remote streams serving this plane to browsers.
- [Observation-seam Agent Note](../../../.agents/notes/implemented/feature/2026-08-24-activity-observation-seam.md) — why the plane is non-consuming and model-invisible.

-----

<a id="model-experience"></a>
## Model Experience

None, as the registry carries live observation state for humans and registers no prompt, tool, or session event; activity output becomes model-visible only through the producers' existing tool results and `ctx.jobs` reads.

#### KV Cache effect

None; the package never assembles or alters provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the contract is a poor fit. They are current package constraints, not a task backlog.

- **Records are process-local and live-only** — a Host restart empties every roster while the transcript keeps the producing tool cards; durable replay is a separate design.
- **The observation plane has no cancellation verb** — stopping work stays with the producers and `ctx.jobs`; a panel-initiated kill is blocked on the jobs `reported` contract question recorded in the [web job display Agent Note](../../../.agents/notes/implemented/feature/2026-08-08-web-background-job-display.md).
- **Settled records last until owner disposal** — retention trims their buffers to the settled cap, but the rows themselves are not aged out.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
