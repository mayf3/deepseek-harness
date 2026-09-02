# Background Task Runtime

English | [中文](jobs.zh.md)

Types shared by long-running producers, `ctx.jobs`, and job controls. The [runtime Agent Note](../../.agents/notes/implemented/architecture/2026-06-20-generic-long-running-tool-runtime.md) owns the design; this page records the exact fields and variants from [`packages/jobs/jobs/src/types.ts`](../../packages/jobs/jobs/src/types.ts).

## Ids and status

`JobId` is a [branded id](core.md#branded-ids) generated as `<kind>-N`. Access control relies on owner authorization, not id secrecy. `JobKind` derives from a merge-extensible map; the registry treats kinds as opaque id namespaces.

```ts type-equiv
/**
 * Producer-defined job kinds. Plugins extend this map by declaration merging;
 * the registry treats every value as an opaque id namespace.
 */
interface JobKindMap {
  bash: 'bash'
  subagent: 'subagent'
}
```

`JobStatus` is `'running' | 'stopping' | 'completed' | 'killed' | 'failed'`; producer-specific facts belong in `JobSnapshot.detail`.

## Producer contract

`JobStart` declares identity and a starter. The runtime finishes preflight before calling `run()` with the job's producer face and commits without a later failable step. Producers own execution resources; the runtime owns identity, access, and lifecycle state.

```ts type-equiv
/**
 * Producer declaration passed to {@link JobRegistry.start}. The runtime
 * preflights access and cleanup before invoking {@link run}; the producer owns
 * execution resources while the runtime owns identity and lifecycle state.
 */
interface JobStart {
  /** Producer kind — also the id prefix (`bash`, `subagent`, …). */
  kind: JobKind
  /** One-line model-facing label (the command; the delegation description). */
  label: string
  /**
   * Optional UTF-8 byte cap for each complete model-facing completion notice or
   * output read, including controller status metadata. Independent of record
   * retention: it bounds the consuming model surface, never
   * {@link JobRegistry.readRecord}.
   */
  outputLimitBytes?: number
  /**
   * Owning live agent. Access is fenced by its session id, and agent disposal
   * cancels and awaits the job. The instance must be the one currently
   * registered under its agent id. Omitting the owner creates an unowned job,
   * open to any caller until service disposal.
   */
  owner?: Agent
  /**
   * Declares an observable output record beside the model-facing surfaces:
   * {@link RunningJob.append} retains chunks in a bounded ring that any number
   * of observers read at absolute byte offsets through
   * {@link JobRegistry.readRecord}, and snapshots carry
   * {@link JobSnapshot.outputTotal} and {@link JobSnapshot.outputEarliest}.
   * Without the declaration `append` logs and drops.
   */
  record?: true
  /**
   * Start the work after preflight and synchronously return its hooks. Called
   * once with the job's producer face; a throw leaves nothing registered (the
   * spent ordinal is skipped), and the producer must clean up any partially
   * started resources.
   * @param job - the issued id plus the record append and live-detail writers.
   */
  run(job: RunningJob): JobHooks
}
```

`JobHooks.done` resolves after the producer releases its resources, not merely when work finishes. Optional `readOutput` distinguishes consuming stream jobs from final-output-only jobs.

```ts type-equiv
/** Hooks through which the runtime controls and observes producer work. */
interface JobHooks {
  /**
   * Request termination. Must be synchronous, idempotent, and eventually settle
   * {@link done}; throws propagate. The optional reason is forwarded verbatim.
   */
  cancel(reason?: string): void
  /**
   * Resolves after the producer releases its resources, not merely when work
   * finishes. Must not reject; the runtime converts a rejection to `failed`.
   * If teardown cancellation throws, the runtime may force-fail only the
   * registry record without claiming that the work stopped. Settlement also
   * ends the record: fold any record-filling pump into this promise so the
   * final drain lands before the registry trims and closes the stream.
   */
  done: Promise<JobOutcome>
  /**
   * Consume output produced since the previous call. The producer formats
   * truncation and spill notices. Absence marks a final-output-only job; each
   * job has one consuming cursor. Independent of the record: this is the
   * model-facing projection, {@link JobRegistry.readRecord} the observer one.
   */
  readOutput?(): string
}
```

```ts type-equiv
/** Terminal result supplied by a producer through {@link JobHooks.done}. */
interface JobOutcome {
  /** How the job ended: finished (`completed`), cancelled (`killed`), or broke (`failed`). */
  status: 'completed' | 'killed' | 'failed'
  /** Kind-specific detail rendered into status lines ('exit code: 3', 'max-tokens'). */
  detail?: string
  /** Final output for jobs without `readOutput`; stream jobs leave it unset. */
  output?: string
}
```

## Observation record

A producer that declares `record: true` streams raw output into a bounded per-job ring through the `RunningJob` face its starter receives; any number of observers read retained chunks at absolute byte offsets through `readRecord` without touching the consuming model cursor or notice state. Job settlement ends the stream and trims retention to the settled cap — the record has no separate lifecycle. `pumpJobOutput` copies producer offset-readers (the subprocess `readFrom` family) into the record at a bounded cadence. Browsers reach the record through `job.observe`, the Remote stream of [`dsh-api-job-controller`](../../packages/api/job-controller/README.md), whose frames are listed under its Cordis API section below.

```ts type-equiv
/**
 * Producer face of one registered job, handed to {@link JobStart.run} and
 * valid for the job's whole life. All methods are synchronous. Writes staged
 * inside the starter call are retained and become visible with the
 * registration commit; after settlement — the producer's own outcome, a kill,
 * or a registry-forced teardown end — both methods log and drop instead of
 * throwing, so a producer's trailing flush cannot break its own teardown path.
 */
interface RunningJob {
  /** The registry-issued id (`<kind>-N`). */
  readonly id: JobId
  /**
   * Append one record chunk. Offsets advance by the chunk's UTF-8 byte
   * length; an empty chunk is dropped without waking observers. Without a
   * {@link JobStart.record} declaration the chunk is logged and dropped.
   * @param text - the chunk text, exactly as produced.
   * @param options - stream label and gap marker.
   */
  append(text: string, options?: JobAppendOptions): void
  /**
   * Replace the snapshot's status detail with a live progress line (`3/10`).
   * Works for every job, with or without a record.
   * @param detail - the new detail line.
   */
  updateDetail(detail: string): void
}
```

```ts type-equiv
/** One retained record chunk returned by {@link JobRegistry.readRecord}. */
interface JobRecordChunk {
  /** Absolute offset of the chunk's first byte. */
  at: number
  /** Chunk text exactly as appended (possibly tail-trimmed by retention). */
  text: string
  /** Stream label, when the producer supplied one. */
  channel?: JobChannel
  /** Producer-reported loss immediately before this chunk. */
  gapBefore?: true
}
```

```ts type-equiv
/** Result of one non-consuming {@link JobRegistry.readRecord}. */
interface JobRecordRead {
  /** Retained chunks overlapping `[from, total)`, in offset order. */
  chunks: readonly JobRecordChunk[]
  /**
   * Offset to resume from — the record's current `outputTotal`. Always a
   * chunk boundary: appends land whole and trimming only advances chunk
   * starts, and consumers concatenate `chunks` under that assumption, so a
   * provider serving partial chunks would silently duplicate text.
   */
  next: number
  /** True when `from` fell below the oldest retained byte, so bytes are missing before `chunks`. */
  lossy: boolean
}
```

## Consumer views

Snapshots are fresh read-only projections. `ownerSession` carries the shared `SessionId` used for authorization; completion listeners separately receive the exact owner object used for lifecycle cleanup. `reported` suppresses a completion notice after another reporter has delivered or committed to deliver the terminal state, including the teardown cancel that drains an owner or the service.

```ts type-equiv
/**
 * A read-only projection of one job, safe to hand to listeners and tools —
 * a fresh object per call, never live registry state.
 */
interface JobSnapshot {
  /** The registry-issued id (`<kind>-N`). */
  id: JobId
  /** The producer kind the job was registered with. */
  kind: JobKind
  /** The producer-supplied one-line label. */
  label: string
  /** Producer-owned cap for complete model-facing notices and output reads. */
  outputLimitBytes?: number
  /**
   * Owner session id used for authorization and correlation; absent for
   * unowned jobs. Completion listeners receive the exact {@link Agent}
   * separately through {@link JobDoneListener}.
   */
  ownerSession?: SessionId
  /** Current lifecycle state. */
  status: JobStatus
  /**
   * Kind-specific status detail: live progress while the producer updates it
   * through {@link RunningJob.updateDetail}, the terminal detail once settled.
   */
  detail?: string
  /** Epoch ms when the job was registered. */
  startedAt: number
  /** Epoch ms when the job settled; absent while `running`/`stopping`. */
  finishedAt?: number
  /**
   * True when a kill, read, wait, or teardown cancel has reported or committed
   * to report the terminal state. Completion reporters suppress redundant
   * notices when set. Teardown claims it because the owner or service being
   * destroyed leaves no reader: a reporter that opens a turn on notice would
   * otherwise spend a model request per teardown layer.
   */
  reported: boolean
  /**
   * Total UTF-8 bytes ever appended to the record — the offset the next chunk
   * starts at. Present exactly when the job declared {@link JobStart.record}.
   */
  outputTotal?: number
  /**
   * Offset of the oldest retained record byte. Greater than zero exactly when
   * retention dropped the head; a reader starting below it gets a lossy read.
   * Present exactly when the job declared {@link JobStart.record}.
   */
  outputEarliest?: number
}
```

```ts type-equiv
/** Output and post-read state returned by {@link JobRegistry.read}. */
interface JobRead {
  /**
   * Stream kinds: the consuming delta since the previous read. Final-output
   * kinds: empty while live, the terminal {@link JobOutcome.output} (or
   * empty) once settled — idempotent, never consumed.
   */
  text: string
  /** The job's state at read time. */
  snapshot: JobSnapshot
}
```

## Service behavior

The abstract [`JobRegistry`](../../packages/jobs/jobs/src/index.ts) Service Definition specifies atomic `start`, caller-scoped `get` and `list`, `read`, non-consuming `readRecord`, `kill`, bounded `wait`, failure-isolated `onJobDone`, `onJobsChanged`, and `onOutput` listeners, and `attachController`; [`LocalJobRegistry`](../../packages/jobs/jobs-local/src/index.ts) is the process-local Service Provider. Authorization compares owner sessions; owner cleanup and admission use the exact registered `Agent` instance. The local provider's positive-safe-integer `maxConcurrentJobsPerOwner` config defaults to `10` and counts `running` plus `stopping` records per exact owner, with one shared bucket for unowned jobs; terminal producer settlement releases capacity, and `retainBytes` (default 262144) with `settledRetainBytes` (default 16384) bound each declared record's live and settled retention. See [`dsh-jobs`](../../packages/jobs/jobs/README.md) for the Service Definition contract, [`dsh-jobs-local`](../../packages/jobs/jobs-local/README.md) for the registry lifecycle and admission policy, and [`dsh-tool-jobs`](../../packages/jobs/tool-jobs/README.md) for the model-facing Consumer.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxjobcontroller--jobcontroller"></a>

### `ctx.jobController` — `JobController`

Host service backing the generated `ctx.remote.job` namespace.

```ts cordis-catalog
/**
 * Stream one job's retained record output from an absolute byte offset,
 * then its terminal status once settled and drained. Non-consuming: the
 * model-facing cursor and notice state never observe these reads. The
 * request's session resolves the fenced-read caller; the registry rejects a
 * job the session does not own, a job without a record, or an unknown job.
 * @param request - target job, owning session, and optional resume offset.
 * @param signal - cancellation owned by the Remote stream carrier.
 * @returns anchor, coalesced output frames, and the terminal status.
 */
@Remote({ mode: 'stream' }) observe(request: JobObserveRequest, signal: AbortSignal): AsyncIterable<JobObserveFrame>
```

Source: [`packages/api/job-controller/src/index.ts`](../../packages/api/job-controller/src/index.ts)

<a id="ctxjobs--jobregistry-abstract-seam"></a>

### `ctx.jobs` — `JobRegistry` (abstract seam)

Abstract background job registry. Subclass, implement the abstract methods, and load the subclass as a plugin — it registers as `ctx.jobs` (one implementation per context; loading a second throws, which is cordis' standard duplicate-service behavior).

Implementations must honor these semantics:

- Registrations outlive producer and controller fibers. Owner and service disposal cancel live work and await compliant producers; a throwing teardown cancel force-fails only the record. Teardown cancellation also marks the record reported, because a record its owner is being destroyed for has no reader left.
- Owned-job access is fenced by the owner's session id. Ids are predictable, so authorization — not secrecy — is the boundary.
- Settlement is first-wins: one terminal record, released waiters, and one round of contained listener notification, even against a late producer outcome. Completion is announced last, after the record is committed and every other observer of the settlement has seen it, because a reporter may open a model turn synchronously.
- start refuses work while no attached job controller serves the spec's owner, so a producer cannot start work that owner cannot collect or stop. One registry serves every composition in the process, so this question — and completion-listener delivery — is owner-relative rather than process-wide: registrations made from an unscoped context serve every owner, and registrations made under an agent composition's scope serve exactly the agents composed under it.
- Record observation never consumes. Any number of readRecord readers hold their own absolute byte offsets; a record read changes no cursor and no notice state, so the model-facing surfaces (the consuming read, completion notices) are unaffected.
- Record retention is bounded. Appends past the live cap drop the oldest retained bytes; a reader below the retained window gets a lossy read, never an error. Settlement — the producer outcome, a kill, or teardown — trims retention to the settled cap and ends the stream; the record has no separate lifecycle.

```ts cordis-catalog
/**
 * Preflight access, validation, owner cleanup, and implementation-owned
 * admission before starting and atomically registering work. Any preflight
 * rejection leaves no job id or execution resource. A throwing starter
 * leaves nothing registered; after it returns, registration cannot fail.
 * Settlement records the outcome, notifies listeners, and releases waiters.
 * @param spec - job identity, owner, and synchronous starter.
 * @returns the registry-issued `<kind>-N` id.
 */
abstract start(spec: JobStart): JobId

/**
 * List caller-owned and unowned jobs in registration order without exposing
 * another session's labels.
 * @param caller - reading agent; a non-agent caller sees only unowned jobs.
 * @returns fresh snapshots.
 */
abstract list(caller?: Agent): JobSnapshot[]

/**
 * Return a non-consuming snapshot without changing its read cursor or notice
 * state. Throws for an unknown or foreign job.
 * @param id - job to look up.
 * @param caller - reading agent checked against the owner.
 * @returns a fresh snapshot.
 */
abstract get(id: JobId, caller?: Agent): JobSnapshot

/**
 * Read the next stream delta, or the idempotent final output after settlement.
 * A terminal read marks the job reported. Throws for an unknown or foreign
 * job.
 * @param id - job to read.
 * @param caller - reading agent checked against the owner.
 * @returns output text and the post-read snapshot.
 */
abstract read(id: JobId, caller?: Agent): JobRead

/**
 * Request cancellation, then mark the job stopping and reported. A producer
 * throw propagates without changing job state. Throws for an unknown or
 * foreign job.
 * @param id - job to cancel.
 * @param caller - killing agent checked against the owner.
 * @param reason - logged reason forwarded to the producer.
 * @returns `requested` for live work, otherwise `already-finished`.
 */
abstract kill(id: JobId, caller?: Agent, reason?: string): 'requested' | 'already-finished'

/**
 * Wait for settlement or timeout without cancelling the job. Caller abort
 * rejects only while the job is live; after settlement the terminal
 * snapshot wins so a notice suppressed for this waiter is still delivered.
 * Throws for invalid, unknown, or foreign input.
 * @param id - job to wait for.
 * @param timeoutMs - positive finite wait bound in milliseconds.
 * @param caller - waiting agent checked against the owner.
 * @param signal - optional cancellation of the wait itself.
 * @returns snapshot at settlement or timeout.
 */
abstract wait(id: JobId, timeoutMs: number, caller?: Agent, signal?: AbortSignal): Promise<JobSnapshot>

/**
 * Register an effect-scoped completion listener. It receives the settlements
 * of the owners its registering context's scope covers; each listener is
 * contained; returned promises are observed but not awaited. No listener runs
 * after service disposal.
 * @param listener - receives each terminal snapshot and its exact owner.
 * @returns disposer that unregisters the listener.
 */
abstract onJobDone(listener: JobDoneListener): () => void

/**
/**
 * Register an effect-scoped observer of visible-set changes. It fires after
 * every commit that changes what {@link list} returns for that owner —
 * registration, every stopping transition (including the one teardown
 * performs before it awaits a slow producer), settlement, owner-disposal
 * removal, and the emptying that service disposal commits — so an observer
 * re-reads rather than accumulating deltas.
 *
 * Delivery is owner-relative on the same terms as {@link onJobDone}: an
 * observer registered from an unscoped context — a host composition's own
 * carrier — sees every owner, while one registered under an agent
 * composition's scope sees exactly the agents composed under it.
 *
 * This is not a superset of {@link onJobDone}: that one delivers the terminal
 * record under first-wins semantics a job controller couples to notice
 * delivery, while this one carries no delivery meaning and marks nothing
 * reported. Listeners are contained and never awaited.
 * @param listener - receives the owner whose visible set changed, or
 *   `undefined` when an unowned job changed and every caller's set did.
 * @returns disposer that unregisters the listener.
 */
abstract onJobsChanged(listener: JobsChangedListener): () => void

/**
 * Read retained record output from an absolute byte offset without consuming
 * it. Resume by passing a previous read's `next`; a foreign offset inside a
 * retained chunk returns that whole chunk (its `at` may precede `from`).
 * Never marks the job reported. Throws for an unknown or foreign job, a job
 * without a {@link JobStart.record} declaration, or a negative or
 * non-integer offset.
 * @param id - job to read.
 * @param from - absolute byte offset to read from (0 for the retained head).
 * @param caller - reading agent checked against the owner.
 * @returns retained chunks overlapping `[from, total)`, the resume offset, and the lossy flag.
 */
abstract readRecord(id: JobId, from: number, caller?: Agent): JobRecordRead

/**
 * Register an effect-scoped observer of record advancement — one signal per
 * committed append and one at settlement, carrying only the job id. A
 * consumer schedules a {@link readRecord} from its own cursor; the registry
 * never pushes payloads. Delivery is owner-relative on the same terms as
 * {@link onJobsChanged}. Listeners are contained and never awaited.
 * @param listener - receives the id whose record advanced.
 * @returns disposer that unregisters the listener.
 */
abstract onOutput(listener: JobOutputListener): () => void

/**
 * Attach an effect-scoped controller that can read and stop jobs. It serves the
 * owners its registering context's scope covers, and {@link start} refuses an
 * owner no attached controller serves.
 * @param name - diagnostic label; duplicate names remain independent.
 * @returns disposer that detaches this controller.
 */
abstract attachController(name: string): () => void
```

Types: [Agent](core.md)

Source: [`packages/jobs/jobs/src/index.ts`](../../packages/jobs/jobs/src/index.ts)
<!-- END GENERATED cordis-surface -->
