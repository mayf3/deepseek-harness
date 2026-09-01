/**
 * Types shared by job producers, the registry, and controllers. The
 * service implementation lives in `./index.ts`.
 * @module @deepseek-ai/dsh-jobs/types
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { JobId } from './brand.ts'

export { JobId } from './brand.ts'

/**
 * Task lifecycle: `running`, optionally `stopping`, then exactly one terminal
 * status. Producer-specific facts belong in {@link JobSnapshot.detail}.
 */
export type JobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed'

/**
 * Producer-defined job kinds. Plugins extend this map by declaration merging;
 * the registry treats every value as an opaque id namespace.
 */
export interface JobKindMap {
  bash: 'bash'
  subagent: 'subagent'
}

/** The merge-extensible union of registered producer kind names. */
export type JobKind = JobKindMap[keyof JobKindMap]

/** Terminal result supplied by a producer through {@link JobHooks.done}. */
export interface JobOutcome {
  /** How the job ended: finished (`completed`), cancelled (`killed`), or broke (`failed`). */
  status: 'completed' | 'killed' | 'failed'
  /** Kind-specific detail rendered into status lines ('exit code: 3', 'max-tokens'). */
  detail?: string
  /** Final output for jobs without `readOutput`; stream jobs leave it unset. */
  output?: string
}

/**
 * Record-stream label. Producers without distinct streams omit it; consumers
 * treat an unrecognized label like an absent one.
 */
export type JobChannel = 'stdout' | 'stderr'

/** Options for one {@link RunningJob.append}. */
export interface JobAppendOptions {
  /** Stream label for the chunk; omitted for producers without distinct streams. */
  channel?: JobChannel
  /**
   * Marks that producer-side bytes between the previous chunk and this one
   * were lost (a source window slid before the producer could copy it), so an
   * observer can render the discontinuity instead of a silent splice.
   */
  gapBefore?: true
}

/**
 * Producer declaration passed to {@link JobRegistry.start}. The runtime
 * preflights access and cleanup before invoking {@link run}; the producer owns
 * execution resources while the runtime owns identity and lifecycle state.
 */
export interface JobStart {
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

/**
 * Producer face of one registered job, handed to {@link JobStart.run} and
 * valid for the job's whole life. All methods are synchronous. Writes staged
 * inside the starter call are retained and become visible with the
 * registration commit; after settlement — the producer's own outcome, a kill,
 * or a registry-forced teardown end — both methods log and drop instead of
 * throwing, so a producer's trailing flush cannot break its own teardown path.
 */
export interface RunningJob {
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

/**
 * A read-only projection of one job, safe to hand to listeners and tools —
 * a fresh object per call, never live registry state.
 */
export interface JobSnapshot {
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

/** Options for {@link JobRegistry.kill}. */
export interface JobKillOptions {
  /**
   * Cancellation reason: forwarded verbatim to the producer's cancel hook, and
   * merged into the terminal `detail` when the job settles `killed`, so both
   * the model and observers can see why the work stopped.
   */
  reason?: string
  /**
   * Whether this kill itself reports the terminal state to the model (default
   * `true`): the killer's own result is the delivery, so the settlement notice
   * is suppressed exactly as before. Pass `false` for a killer with no
   * model-visible channel (a human cancellation from a client UI) — the job
   * settles unreported and the standard completion notice stays due under the
   * completion reporter's own delivery rules. `false` never clears an existing
   * claim: a job the model already killed stays reported.
   */
  reported?: boolean
}

/** Output and post-read state returned by {@link JobRegistry.read}. */
export interface JobRead {
  /**
   * Stream kinds: the consuming delta since the previous read. Final-output
   * kinds: empty while live, the terminal {@link JobOutcome.output} (or
   * empty) once settled — idempotent, never consumed.
   */
  text: string
  /** The job's state at read time. */
  snapshot: JobSnapshot
}

/** One retained record chunk returned by {@link JobRegistry.readRecord}. */
export interface JobRecordChunk {
  /** Absolute offset of the chunk's first byte. */
  at: number
  /** Chunk text exactly as appended (possibly tail-trimmed by retention). */
  text: string
  /** Stream label, when the producer supplied one. */
  channel?: JobChannel
  /** Producer-reported loss immediately before this chunk. */
  gapBefore?: true
}

/** Result of one non-consuming {@link JobRegistry.readRecord}. */
export interface JobRecordRead {
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

/**
 * Completion callback with the exact owner supplied at start, or `undefined`
 * for an unowned job. Returned promises are observed but not awaited.
 */
export type JobDoneListener = (
  snapshot: JobSnapshot,
  owner: Agent | undefined,
) => void | PromiseLike<void>

/**
 * Observation callback for a change to what one owner's {@link JobRegistry.list}
 * would return. It is owner-granular rather than job-granular because the
 * change may be a removal, which no per-job record can express, and because
 * its consumers re-read the whole visible set anyway.
 *
 * An `undefined` owner means an unowned job changed, so every caller's visible
 * set changed with it.
 */
export type JobsChangedListener = (owner: Agent | undefined) => void

/**
 * Observer of record advancement for one job: new appended output, or the
 * settlement that ends the stream. Carries no payload — a consumer schedules a
 * {@link JobRegistry.readRecord} from its own cursor.
 */
export type JobOutputListener = (id: JobId) => void
