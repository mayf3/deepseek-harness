# Live Activity Observation

English | [中文](activity.zh.md)

Types shared by streaming-output producers, `ctx.activities`, and the observation consumers. The [observation-seam Agent Note](../../.agents/notes/implemented/feature/2026-08-24-activity-observation-seam.md) owns the design; this page records the cross-package vocabulary from [`packages/activity/activity/src/types.ts`](../../packages/activity/activity/src/types.ts) and the wire frames from [`packages/api/activity-controller/src/types.ts`](../../packages/api/activity-controller/src/types.ts).

An **activity** is one observable unit of long-running work: an append-only bounded output stream plus live status. The registry is a pure observation plane — it starts nothing, cancels nothing, and is invisible to the model. Producers keep their execution resources and their model-facing surfaces (`ctx.jobs` consuming cursors, tool results); observers read non-consumingly at absolute byte offsets, so any number of them coexist with the model's single consuming cursor.

## Ids, kinds, and correlation

`ActivityId` is a [branded id](core.md#branded-ids) generated as `<kind>-N`; visibility relies on owner authorization, not id secrecy. `ActivityKindMap` is merge-extensible (`bash` seeded; `pwsh` and `workflow` merged by their producers). `ActivityCorrelation` links one activity to the `CallId` that started the work and the `JobId` carrying its model-facing control surface, so a consumer attaches the stream to an existing card or row without guessing from labels.

## Producer face

`open(spec)` returns an `ActivityHandle` with synchronous `append(text, { channel?, gapBefore? })`, `updateDetail(detail)`, and first-wins `end(outcome)`. Offsets advance by each chunk's UTF-8 byte length; `gapBefore` marks producer-side loss so a discontinuity stays visible. After `end` — including a teardown force-end — `append` and `updateDetail` log and drop rather than throw, so a producer's trailing flush cannot break its own teardown.

`pumpActivityOutput(handle, sources, { pollMs, done })` adapts pull substrates: it copies each non-consuming offset reader (the subprocess `readFrom(fromByte)` family, re-exposed on `ShellProcess.observed`) into the handle at a bounded cadence and drains once more after `done` settles. Push-natural producers (the workflow tool's run mirror) append directly.

## Observation

`read(id, from, caller?)` returns the retained chunks overlapping `[from, total)` and the resume offset `next`, consuming nothing. Offsets stay absolute across eviction: `outputEarliest` on the snapshot names the oldest retained byte, and a read below it is `lossy: true`, never an error. Retention is provider policy ([`dsh-activity-local`](../../packages/activity/activity-local/README.md): `retainBytes` live, trimmed to `settledRetainBytes` at settlement).

Two effect-scoped listener families deliver owner-relative on the jobs-registry terms: `onActivitiesChanged` fires per visible-set change (open, detail, settlement, removal) so consumers re-read whole rows, and `onOutput` signals stream advancement (append or settlement) carrying only the id, so each consumer reads from its own cursor.

## Wire transport

[`dsh-api-activity-controller`](../../packages/api/activity-controller/README.md) exposes the plane to browsers as two Remote streams: `activity.control` (baseline plus whole-bucket roster replacement frames) and `activity.observe` (one `opened` anchor, coalesced `output` frames, then the terminal `status` on the same stream, after which the generation closes). Output frames are transient — durable history stays with the producers' tool results, exactly as the [web job display decision](../../.agents/notes/implemented/feature/2026-08-08-web-background-job-display.md) requires. [`dsh-client-ui-activity`](../../packages/client/ui-activity/README.md) renders the roster in the session header and opens observation streams only while a panel is expanded.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxactivities--activityregistry-abstract-seam"></a>

### `ctx.activities` — `ActivityRegistry` (abstract seam)

Abstract streaming-output registry. Subclass, implement the abstract methods, and load the subclass as a plugin — it registers as `ctx.activities` (one implementation per context; loading a second throws, which is cordis' standard duplicate-service behavior).

Implementations must honor these semantics:

- Observation never consumes. Any number of readers hold their own absolute byte offsets; a read changes no cursor and no producer state, so the model-facing paths (`ctx.jobs.read()`, tool results) are unaffected.
- Records outlive producer fibers. Owner disposal ends still-open records and removes them; service disposal ends and clears everything. Neither awaits a producer — the registry owns no execution resource.
- Retention is bounded. Appends past the live cap drop the oldest retained bytes; a reader below the retained window gets a lossy read, never an error. Settlement trims retention to the settled cap.
- Listener delivery is owner-relative: a listener registered from an unscoped context — a host composition's own carrier — sees every owner, while one registered under an agent composition's scope sees exactly the agents composed under it. Every listener is contained.

```ts cordis-catalog
/**
 * Validate the spec, attach owner cleanup, and atomically register one
 * activity. A rejection leaves no id; after return the producer owns the
 * handle and the visible set has changed.
 * @param spec - activity identity, owner, and correlation.
 * @returns the producer face of the registered activity.
 */
abstract open(spec: ActivityOpen): ActivityHandle

/**
 * List caller-owned and unowned activities in registration order without
 * exposing another session's labels or output.
 * @param caller - reading agent; a non-agent caller sees only unowned activities.
 * @returns fresh snapshots.
 */
abstract list(caller?: Agent): ActivitySnapshot[]

/**
 * Return a fresh snapshot. Throws for an unknown or foreign activity.
 * @param id - activity to look up.
 * @param caller - reading agent checked against the owner.
 * @returns a fresh snapshot.
 */
abstract get(id: ActivityId, caller?: Agent): ActivitySnapshot

/**
 * Read retained output from an absolute byte offset without consuming it.
 * Resume by passing a previous read's `next`; a foreign offset inside a
 * retained chunk returns that whole chunk (its `at` may precede `from`).
 * Throws for an unknown or foreign activity or a negative or non-integer
 * offset.
 * @param id - activity to read.
 * @param from - absolute byte offset to read from (0 for the retained head).
 * @param caller - reading agent checked against the owner.
 * @returns retained chunks overlapping `[from, total)`, the resume offset, and the lossy flag.
 */
abstract read(id: ActivityId, from: number, caller?: Agent): ActivityRead

/**
 * Register an effect-scoped observer of visible-set changes: opening,
 * detail updates, settlement, owner-disposal removal, and the emptying that
 * service disposal commits — so an observer re-reads rather than
 * accumulating deltas. Listeners are contained and never awaited.
 * @param listener - receives the owner whose visible set changed, or
 *   `undefined` when an unowned activity changed and every caller's set did.
 * @returns disposer that unregisters the listener.
 */
abstract onActivitiesChanged(listener: ActivitiesChangedListener): () => void

/**
 * Register an effect-scoped observer of stream advancement — one signal per
 * committed append and one at settlement, carrying only the activity id.
 * A consumer schedules a {@link read} from its own cursor; the registry
 * never pushes payloads. Listeners are contained and never awaited.
 * @param listener - receives the id whose stream advanced.
 * @returns disposer that unregisters the listener.
 */
abstract onOutput(listener: ActivityOutputListener): () => void
```

Types: [Agent](core.md)

Source: [`packages/activity/activity/src/index.ts`](../../packages/activity/activity/src/index.ts)

<a id="ctxactivitycontroller--activitycontroller"></a>

### `ctx.activityController` — `ActivityController`

Host service backing the generated `ctx.remote.activity` namespace.

```ts cordis-catalog
/**
 * Stream a complete roster baseline followed by whole-bucket replacements.
 * @param signal - generation cancellation.
 * @returns baseline followed by per-owner roster replacement frames.
 */
@Remote({ mode: 'stream' }) control(signal: AbortSignal): AsyncIterable<ActivityControlFrame>

/**
 * Stream one activity's retained output from an absolute byte offset, then
 * its terminal status once settled and drained. Non-consuming: the
 * model-facing cursors never observe these reads.
 * @param request - target activity and optional resume offset.
 * @param signal - generation cancellation.
 * @returns anchor, coalesced output frames, and the terminal status.
 */
@Remote({ mode: 'stream' }) observe(request: ActivityObserveRequest, signal: AbortSignal): AsyncIterable<ActivityObserveFrame>
```

Source: [`packages/api/activity-controller/src/index.ts`](../../packages/api/activity-controller/src/index.ts)
<!-- END GENERATED cordis-surface -->
