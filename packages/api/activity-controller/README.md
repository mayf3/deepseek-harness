---
description: "Activity Remote streams for browsers: the activity.control roster stream, per-activity activity.observe output streams with flushMs coalescing and maxFrameBytes budgets, and the ctx.activityFeed client model."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-activity-controller

English | [中文](README.zh.md)

## Summary

`dsh-api-activity-controller` streams the live-activity plane to browsers: a client follows one roster stream for every visible task row and opens one observation stream per expanded panel, resuming across reconnects from its own cursor. A pure read surface — it starts nothing, cancels nothing, and never touches the model-facing consuming cursors; the wire path reads only the registry's non-consuming offsets. A composition without `ctx.activities` still serves an empty baseline, so the client degrades to no live rows rather than an error.

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

Mount the host row beside `dsh-typert-registry` and load the client half through the plugin manifest; UI features then consume `ctx.activityFeed` instead of raw streams.

### The two Remote streams

The Host `ActivityController` (namespace `activity`) exposes two `@Remote({ mode: 'stream' })` methods:

- `control(signal)` — one complete roster baseline, then whole-bucket replacement frames per owner session on every registry change (the self-healing shape the session control stream uses for jobs). A composition without the registry serves an empty baseline. The Remote tier deliberately serves every session's rows to any connected browser, and `observe` satisfies the registry's owner fence with the mirrored owner: the per-session fence is an in-process contract, and this single-user local BFF reads across it exactly as the session control stream does for `jobsBySession`.
- `observe({ activityId, from? }, signal)` — one `opened` anchor, coalesced `output` frames (`flushMs` window, `maxFrameBytes` soft budget; one larger chunk ships whole), then one terminal `status` after the settled activity is drained, after which the generation closes normally. Reconnecting callers resume by passing the last frame's `next`; a resume behind the retained window arrives flagged `lossy`. Status rides the same stream as output, so settlement can never race a still-open output channel.

| Config | Default | Meaning |
|---|---|---|
| `flushMs` | `100` | Coalescing window after new output before an observation read. |
| `maxFrameBytes` | `65536` | Soft byte budget per observation output frame. |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-api-activity-controller) is the exhaustive source for every accepted field.

### The client feed

The client half (`./client`) installs `ctx.activityFeed`: `ClientActivityModel` mirrors the roster (last-wins buckets, generation replace) and accumulates each observed activity's bounded render tail, and `ClientActivityFeed.observe(id)` opens reference-counted observation streams that resume from the model's cursor across carrier generations.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host side mirrors the registry into owner buckets (`ActivityFeed`), fans control frames out to per-generation followers, and runs each observation as an async generator that subscribes before its first read so no append lands between anchor and stream. The client side keeps observation state per activity with a resume cursor; release closures bind the exact entry they were minted for, so a superseded observation's late release can neither tear down nor clear its successor.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `ActivityController`: the two Remote stream methods |
| [`src/feed.ts`](src/feed.ts) | Owner-bucket roster mirror and control-stream followers |
| [`src/observe.ts`](src/observe.ts) | Per-activity observation generator: anchor, coalescing, terminal status |
| [`src/client/model.ts`](src/client/model.ts) | Roster and observation state with the bounded render tail |
| [`src/client/service.ts`](src/client/service.ts) | `ctx.activityFeed`: reference-counted observation streams |
| [`src/client/index.ts`](src/client/index.ts) | Client plugin: roster stream wiring and the service install |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-activity`](../../activity/activity/README.md) — the observation contract this transport reads.
- [`dsh-client-ui-activity`](../../client/ui-activity/README.md) — the task list rendering `ctx.activityFeed`.
- [docs/subsystems/activity.md](../../../docs/subsystems/activity.md) — the plane end to end, wire shapes included.

-----

<a id="model-experience"></a>
## Model Experience

None, as activity transport is browser and Host observation state and registers no prompt, tool, or session event.

#### KV Cache effect

None; the package never assembles or alters provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the transport is a poor fit. They are current package constraints, not a task backlog.

- **Registry presence is sampled at construction** — a registry mounted after the controller stays unobserved until the controller reloads.
- **The roster names no watermark** — an observation stream anchors itself; correlating roster rows against observation offsets is client policy.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
