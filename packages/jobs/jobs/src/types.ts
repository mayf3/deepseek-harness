/**
 * Types shared by job producers, the registry, and its consumers. The
 * client-safe projection vocabulary lives in `./view.ts`; the service
 * implementation lives in `./index.ts`.
 * @module @deepseek-ai/dsh-jobs/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { JobId } from './brand.ts'
import type { JobChannel, JobChunk, JobKind, JobView } from './view.ts'

export { JobId } from './brand.ts'
export type { JobChannel, JobChunk, JobKind, JobKindMap, JobStatus, JobView } from './view.ts'

/** Terminal result supplied by a producer through {@link JobHooks.done}. */
export interface JobOutcome {
  /** How the job ended: finished (`completed`), cancelled (`killed`), or broke (`failed`). */
  status: 'completed' | 'killed' | 'failed'
  /**
   * Terminal reason rendered into status lines (`exit code: 3`, `max-tokens`).
   * When the job settles `killed` after a {@link CallerJobs.kill} with a
   * reason, the registry appends that reason.
   */
  detail?: string
  /**
   * Return value for jobs whose result is a value rather than a stream (a
   * workflow's rendered result, a subagent's report). The output ring carries
   * the stream; this is handed out once by the model's next {@link CallerJobs.read}.
   */
  result?: string
}

/** One incremental read from a {@link JobOutputSource}. */
export interface JobSourceRead {
  /** Text captured since the requested offset (the whole retained tail when lossy). */
  text: string
  /** Whole-stream offset to resume from on the next read. */
  nextOffset: number
  /** True when the requested offset slid out of the source's retained window. */
  lossy: boolean
  /**
   * Host path of a file holding the complete stream, when the source
   * currently keeps an intact one. Reported on every read, so the registry
   * tracks it as source metadata: a later read without it withdraws the file.
   */
  spillPath?: string
}

/**
 * A pull source the registry pumps into the job's output ring — the subprocess
 * `readFrom` family. The registry owns the cadence and drains every source one
 * last time before settlement closes the ring, so a producer folds nothing
 * into its `done`.
 */
export interface JobOutputSource {
  /** Stream label attached to every chunk this source yields. */
  channel?: JobChannel
  /**
   * Read everything captured since `fromByte` without consuming it.
   * @param fromByte - whole-stream offset to resume from (a prior read's `nextOffset`; 0 first).
   * @returns the delta text, the next offset, the lossy flag, and the spill path the source currently keeps.
   */
  read(fromByte: number): JobSourceRead
}

/** Options for one {@link JobHandle.append}. */
export interface JobAppendOptions {
  /** Stream label for the chunk; omitted for producers without distinct streams. */
  channel?: JobChannel
  /**
   * Marks that producer-side bytes between the previous chunk and this one
   * were lost, so an observer can render the discontinuity instead of a
   * silent splice.
   */
  gapBefore?: true
}

/**
 * Producer face of one registered job, handed to {@link JobSpec.run} and
 * valid for the job's whole life. All methods are synchronous. Writes staged
 * inside the starter call are retained and become visible with the
 * registration commit; after settlement — the producer's own outcome, a kill,
 * or a registry-forced teardown end — writes log and drop instead of
 * throwing, so a producer's trailing flush cannot break its own teardown path.
 */
export interface JobHandle {
  /** The registry-issued id (`<kind>-N`). */
  readonly id: JobId
  /**
   * Append one chunk to the output ring. Offsets advance by the chunk's UTF-8
   * byte length; an empty chunk is dropped without waking observers.
   * @param text - the chunk text, exactly as produced.
   * @param options - stream label and gap marker.
   */
  append(text: string, options?: JobAppendOptions): void
  /**
   * Replace the live progress line (`3/10`, the current phase). Settlement
   * clears it; the terminal reason travels in {@link JobOutcome.detail}.
   * @param line - the new progress line.
   */
  updateProgress(line: string): void
}

/** Hooks through which the runtime controls and observes producer work. */
export interface JobHooks {
  /**
   * Request termination. Must be synchronous, idempotent, and eventually settle
   * {@link done}; throws propagate. The optional reason is forwarded verbatim.
   */
  cancel(reason?: string): void
  /**
   * Resolves after the producer releases its resources, not merely when work
   * finishes. Must not reject; the runtime converts a rejection to `failed`.
   * If teardown cancellation throws, the runtime may force-fail only the
   * registry record without claiming that the work stopped.
   */
  done: Promise<JobOutcome>
}

/**
 * Producer declaration passed to {@link JobRegistry.start}. The runtime
 * preflights access and cleanup before invoking {@link run}; the producer owns
 * execution resources while the runtime owns identity, lifecycle state, and
 * the output ring.
 */
export interface JobSpec {
  /** Producer kind — also the id prefix (`bash`, `subagent`, …). */
  kind: JobKind
  /** One-line model-facing label (the command; the delegation description). */
  label: string
  /**
   * Owning session. Access is fenced by it, and the owner's live Agent must be
   * the one currently registered under that id: its disposal cancels and
   * awaits the job. Omitting the owner creates an unowned job, open to any
   * caller until service disposal.
   */
  owner?: SessionId
  /**
   * Optional UTF-8 byte cap for each complete model-facing completion notice or
   * output read, including controller status metadata. Independent of ring
   * retention: it bounds the consuming model surface, never observers.
   */
  outputLimitBytes?: number
  /**
   * Pull sources the registry pumps into the ring at its own cadence.
   * Producers that narrate their own progress use {@link JobHandle.append}
   * instead; a job may use both.
   */
  output?: readonly JobOutputSource[]
  /**
   * Start the work after preflight and synchronously return its hooks. Called
   * once with the job's producer face; a throw leaves nothing registered (the
   * spent ordinal is skipped), and the producer must clean up any partially
   * started resources.
   * @param job - the issued id plus the ring append and progress writers.
   */
  run(job: JobHandle): JobHooks
}

/** Options for {@link CallerJobs.kill}. */
export interface JobKillOptions {
  /**
   * Cancellation reason: forwarded verbatim to the producer's cancel hook, and
   * merged into the terminal `detail` when the job settles `killed`, so both
   * the model and observers can see why the work stopped.
   */
  reason?: string
}

/** Output and post-read state returned by the consuming {@link CallerJobs.read}. */
export interface JobRead {
  /** Ring chunks appended since the model cursor, in offset order; every channel included. */
  chunks: readonly JobChunk[]
  /** True when the cursor fell below the oldest retained byte, so bytes are missing before `chunks`. */
  lossy: boolean
  /** The producer's {@link JobOutcome.result}, handed out by the first read after settlement only. */
  result?: string
  /** The job's state at read time. */
  job: JobView
}

/** Result of one non-consuming {@link CallerJobs.readAt}. */
export interface JobOutputRead {
  /** Retained chunks overlapping `[from, total)`, in offset order. */
  chunks: readonly JobChunk[]
  /**
   * Offset to resume from — the ring's current `total`. Always a chunk
   * boundary: appends land whole and trimming only advances chunk starts, and
   * consumers concatenate `chunks` under that assumption, so a provider
   * serving partial chunks would silently duplicate text.
   */
  next: number
  /** True when `from` fell below the oldest retained byte, so bytes are missing before `chunks`. */
  lossy: boolean
}

/**
 * The operations one caller may perform, bound by {@link JobRegistry.forCaller}.
 * A caller sees its own jobs and every unowned job; every method throws for
 * an id outside that set, without distinguishing unknown from foreign.
 */
export interface CallerJobs {
  /**
   * List the visible jobs in registration order.
   * @returns fresh projections.
   */
  list(): JobView[]
  /**
   * Project one job without touching its cursor.
   * @param id - job to look up.
   * @returns a fresh projection.
   */
  get(id: JobId): JobView
  /**
   * Consume the ring from the model cursor and advance it to the current
   * total. After settlement the first read also carries the producer's
   * result; later reads return only what was appended since.
   * @param id - job to read.
   * @returns the chunks since the cursor, the lossy flag, the result once, and the post-read projection.
   */
  read(id: JobId): JobRead
  /**
   * Read retained ring output from an absolute byte offset without consuming
   * it. Resume by passing a previous read's `next`; an offset inside a
   * retained chunk returns that whole chunk (its `at` may precede `from`).
   * Never moves the model cursor. Throws for a negative or non-integer offset.
   * @param id - job to read.
   * @param from - absolute byte offset to read from (0 for the retained head).
   * @returns retained chunks overlapping `[from, total)`, the resume offset, and the lossy flag.
   */
  readAt(id: JobId, from: number): JobOutputRead
  /**
   * Request cancellation, then mark the job stopping. A recorded
   * {@link JobKillOptions.reason} merges into the terminal `detail` when the
   * job settles `killed`. A producer throw propagates without changing job
   * state.
   * @param id - job to cancel.
   * @param options - cancellation reason.
   * @returns `requested` for live work, otherwise `already-finished`.
   */
  kill(id: JobId, options?: JobKillOptions): 'requested' | 'already-finished'
  /**
   * Wait for settlement or timeout without cancelling the job. Caller abort
   * rejects only while the job is live; after settlement the terminal
   * projection wins. Throws for an invalid timeout.
   * @param id - job to wait for.
   * @param timeoutMs - positive finite wait bound in milliseconds.
   * @param signal - optional cancellation of the wait itself.
   * @returns projection at settlement or timeout.
   */
  wait(id: JobId, timeoutMs: number, signal?: AbortSignal): Promise<JobView>
}

/**
 * Why a job settled: its producer finished (`producer`), a
 * {@link CallerJobs.kill} ran first (`kill`), or owner or service teardown
 * cancelled it (`teardown`) — a settlement whose owner has no reader left.
 */
export type JobSettleCause = 'producer' | 'kill' | 'teardown'

/**
 * One lifecycle or output event. Lifecycle events carry the job's projection
 * after the commit they announce; `output` carries only the id and the new
 * total, so an observer schedules a {@link CallerJobs.readAt} from its own
 * cursor and the registry never pushes payloads.
 */
export type JobEvent =
  | {
    /** Registration commit, progress line change, stopping transition, or removal from the visible set. */
    readonly type: 'registered' | 'progress' | 'stopping' | 'removed'
    readonly job: JobView
  }
  | {
    readonly type: 'settled'
    readonly job: JobView
    readonly cause: JobSettleCause
  }
  | {
    readonly type: 'output'
    readonly id: JobId
    /** Owning session, absent for an unowned job. */
    readonly owner?: SessionId
    /** The ring's total after the append (or at settlement, which ends the stream). */
    readonly total: number
  }

/**
 * Who a subscription hears about. `{ owner }` delivers that session's jobs
 * plus every unowned job (the set that session can see). `{ owners: 'scope' }`
 * delivers the owners composed under the subscribing context — one registry
 * serves every composition in the process, and a mount under one preset must
 * not hear another preset's agents. `{ owners: 'all' }` delivers everything.
 */
export type JobEventFilter =
  | { readonly owner: SessionId }
  | { readonly owners: 'all' | 'scope' }

/** Event callback; contained by the registry, never awaited. */
export type JobEventListener = (event: JobEvent) => void

/** The registry's event stream. */
export interface JobEvents {
  /**
   * Register an effect-scoped listener. Events are dispatched synchronously
   * after the commit they announce; a job's first event is `registered`, and
   * a `settled` event follows the release of every waiter. No listener runs
   * after service disposal.
   * @param filter - which owners' events to deliver.
   * @param listener - receives each matching event.
   * @returns disposer that unregisters the listener.
   */
  subscribe(filter: JobEventFilter, listener: JobEventListener): () => void
}
