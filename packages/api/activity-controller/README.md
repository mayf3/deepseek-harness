# @deepseek-ai/dsh-api-activity-controller

English | [中文](README.zh.md)

Activity Remote streams over the optional `ctx.activities` registry, plus their React-free client model. A pure read surface: it starts nothing, cancels nothing, and never touches the model-facing consuming cursors — the wire path reads only the registry's non-consuming offsets.

The Host `ActivityController` (namespace `activity`) exposes two `@Remote({ mode: 'stream' })` methods:

- `control(signal)` — one complete roster baseline, then whole-bucket replacement frames per owner session on every registry change (the self-healing shape the session control stream uses for jobs). A composition without the registry serves an empty baseline.
- `observe({ activityId, from? }, signal)` — one `opened` anchor, coalesced `output` frames (`flushMs` window, `maxFrameBytes` soft budget; one larger chunk ships whole), then one terminal `status` after the settled activity is drained, after which the generation closes normally. Reconnecting callers resume by passing the last frame's `next`; a resume behind the retained window arrives flagged `lossy`. Status rides the same stream as output, so settlement can never race a still-open output channel.

| Config | Default | Meaning |
|---|---|---|
| `flushMs` | `100` | Coalescing window after new output before an observation read. |
| `maxFrameBytes` | `65536` | Soft byte budget per observation output frame. |

The client half (`./client`) installs `ctx.activityFeed`: `ClientActivityModel` mirrors the roster (last-wins buckets, generation replace) and accumulates each observed activity's bounded render tail, and `ClientActivityFeed.observe(id)` opens reference-counted observation streams that resume from the model's cursor across carrier generations.

## Model Experience

None, as activity transport is browser and Host observation state and registers no prompt, tool, or session event.

#### KV Cache effect

None; the package never assembles or alters provider requests.

## Known Limitations and Deferred Work

- **Registry presence is sampled at construction** — a registry mounted after the controller stays unobserved until the controller reloads.
- **The roster names no watermark** — an observation stream anchors itself; correlating roster rows against observation offsets is client policy.
