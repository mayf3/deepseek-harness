# @deepseek-ai/dsh-activity

English | [中文](README.zh.md)

The streaming-output observation contract (`ctx.activities`). The abstract `ActivityRegistry` and its vocabulary types give any long-running producer one place to publish live output and status, and any number of independent consumers non-consuming reads over it; the in-memory registry lives in [`dsh-activity-local`](../activity-local/README.md). Producer plugins extend `ActivityKindMap` with their opaque id namespace and may link an activity to its tool call and background job through `ActivityCorrelation`.

The registry is a pure observation plane: it starts nothing, cancels nothing, and is invisible to the model. Producers keep their execution resources and their existing model-facing surfaces; a composition without this seam loses only live observation.

## Service contract

- `open(spec): ActivityHandle` validates the kind, label, and exact live owner, then atomically registers the record and returns the producer face: synchronous `append(text, { channel?, gapBefore? })`, `updateDetail(detail)`, and first-wins `end(outcome)`. After `end` — including a teardown force-end — `append` and `updateDetail` log and drop instead of throwing, so a producer's trailing flush cannot break its own teardown.
- `get(id, caller?)` and `list(caller?)` return fresh snapshots. Listing includes only caller-owned and unowned activities; owned access compares the activity's `SessionId` with the caller's, and predictable ids make that fence the boundary.
- `read(id, from, caller?)` returns the retained chunks overlapping `[from, total)` plus the resume offset, without consuming anything. Offsets are absolute UTF-8 byte positions that survive eviction; a reader below the oldest retained byte gets `lossy: true`, never an error.
- `onActivitiesChanged(listener)` observes visible-set changes — opening, detail updates, settlement, owner-disposal removal, and the emptying service disposal commits — so consumers re-read rather than accumulate deltas. `onOutput(listener)` signals stream advancement (one signal per committed append and one at settlement) carrying only the id; a consumer reads from its own cursor. Both deliver owner-relative on the jobs-registry terms and contain every listener.

`pumpActivityOutput(handle, sources, { pollMs, done })` is the shared pump for producers whose substrate is a non-consuming offset reader (the subprocess `readFrom(fromByte)` family): it copies labeled deltas at a bounded cadence, marks a lossy source read `gapBefore`, and drains once more after `done` settles without ever calling `end()` itself.

See the [activity subsystem page](../../../docs/subsystems/activity.md) and the [observation-seam Agent Note](../../../.agents/notes/implemented/feature/2026-08-24-activity-observation-seam.md).

## Model Experience

None, as the registry carries live observation state for humans and registers no prompt, tool, or session event; activity output becomes model-visible only through the producers' existing tool results and `ctx.jobs` reads.

#### KV Cache effect

None; the package never assembles or alters provider requests.

## Known Limitations and Deferred Work

- **Records are process-local and live-only** — a Host restart empties every roster while the transcript keeps the producing tool cards; durable replay is a separate design.
- **The observation plane has no cancellation verb** — stopping work stays with the producers and `ctx.jobs`; a panel-initiated kill is blocked on the jobs `reported` contract question recorded in the [web job display Agent Note](../../../.agents/notes/implemented/feature/2026-08-08-web-background-job-display.md).
- **Settled records last until owner disposal** — retention trims their buffers to the settled cap, but the rows themselves are not aged out.
