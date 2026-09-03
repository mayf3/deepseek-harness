/**
 * Process-local provider for the background-job capability seam
 * (`ctx.jobs`). It keeps every record — lifecycle state plus the optional
 * bounded output ring — in memory and hands out fresh snapshots and chunk
 * copies, never live state.
 *
 * Registrations outlive producer and controller fibers. Agent or service
 * disposal cancels live work and awaits compliant producers; a throwing
 * teardown cancel force-fails only the record and reports a possible orphan.
 * @module @deepseek-ai/dsh-jobs-local
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AnonymousEntries, ScopedLayers, scopeOf } from '@deepseek-ai/dsh-scope'
import type { ScopeLayer } from '@deepseek-ai/dsh-scope'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { JobRegistry, JobId } from '@deepseek-ai/dsh-jobs'
import type {
  JobAppendOptions, JobChannel, JobDoneListener, JobKillOptions, JobKind, JobOutcome,
  JobOutputListener, JobRead, JobRecordChunk, JobRecordRead, JobsChangedListener, JobSnapshot,
  JobStart, JobStatus, RecordingJob, RunningJob,
} from '@deepseek-ai/dsh-jobs'

/** Timeout code that distinguishes a bounded wait from caller cancellation. */
export const TASK_WAIT_TIMEOUT = 'TASK_WAIT_TIMEOUT'

/** Default maximum number of active jobs in one exact-owner bucket. */
const DEFAULT_MAX_CONCURRENT_TASKS_PER_OWNER = 10

/** Default live record retention per job, in UTF-8 bytes. */
const DEFAULT_RETAIN_BYTES = 256 * 1024

/** Default record retention kept after settlement, in UTF-8 bytes. */
const DEFAULT_SETTLED_RETAIN_BYTES = 16 * 1024

/** Configuration for the process-local job registry. */
export interface Config {
  /**
   * Maximum `running` plus `stopping` jobs per exact owner or in the shared unowned bucket;
   * omission defaults to 10.
   */
  maxConcurrentJobsPerOwner?: number
  /** Live record retention per job in UTF-8 bytes; omission defaults to 262144. */
  retainBytes?: number
  /** Record retention kept after a job settles, in UTF-8 bytes; omission defaults to 16384. */
  settledRetainBytes?: number
}

/** One retained record ring entry; `bytes` caches the chunk's UTF-8 length. */
interface RingChunk {
  at: number
  text: string
  bytes: number
  channel?: JobChannel
  gapBefore?: true
}

/** The bounded output ring behind one job's declared record. */
interface RecordState {
  /** Retained chunks in offset order; offsets stay absolute across eviction. */
  chunks: RingChunk[]
  /** Sum of the retained chunks' byte lengths. */
  retainedBytes: number
  /** Total UTF-8 bytes ever appended. */
  total: number
  /** Offset of the oldest retained byte (equals {@link total} when nothing is retained). */
  earliest: number
}

/**
 * Producer-written state shared between the {@link RunningJob} face and the
 * registered record: the starter call writes through it before the commit,
 * the same object serves the job for its whole life afterwards.
 */
interface ProducerState {
  /** Bounded output ring; undefined when the spec declared no record. */
  record: RecordState | undefined
  /** Live progress detail until settlement replaces it with the terminal one. */
  detail: string | undefined
  /** The committed registry record; undefined exactly during the starter call. */
  job: TrackedTask | undefined
}

/** The registry's mutable per-job record (never handed out — see {@link LocalJobRegistry.snapshot}). */
interface TrackedTask {
  id: JobId
  kind: JobKind
  label: string
  outputLimitBytes: number | undefined
  /** Exact lifecycle owner; session-id authorization is derived from it. */
  owner: Agent | undefined
  cancel: (reason?: string) => void
  readOutput: (() => string) | undefined
  status: JobStatus
  /** Producer-shared record ring and detail line. */
  state: ProducerState
  output: string | undefined
  startedAt: number
  finishedAt: number | undefined
  reported: boolean
  /** Reason recorded by {@link LocalJobRegistry.kill}, merged into a `killed` settlement's detail. */
  killReason: string | undefined
  /** Resolves once the terminal snapshot is recorded and listeners notified. */
  settled: Promise<void>
  /** Resolver for {@link settled}, called by the first effective settlement. */
  markSettled: () => void
  /** Live waits; settlement with a waiter marks the job reported. */
  waiters: number
  /** Removable resolvers for live waits; timeout/abort unregister before the job settles. */
  waitResolvers: Set<() => void>
}

/** True for the three terminal {@link JobStatus} values. */
function isTerminal(status: JobStatus): boolean {
  return status === 'completed' || status === 'killed' || status === 'failed'
}

/**
 * The UTF-8-safe tail of `text` no longer than `maxBytes`: the byte cut
 * advances past continuation bytes so the surviving text never starts inside
 * a code point.
 * @param text - the oversized chunk text.
 * @param maxBytes - positive byte budget for the surviving tail.
 * @returns the surviving tail and its exact byte length.
 */
function utf8Tail(text: string, maxBytes: number): { text: string; bytes: number } {
  const raw = Buffer.from(text, 'utf8')
  let start = raw.length - maxBytes
  // The loop bound proves the index is in range; the assertion only
  // discharges noUncheckedIndexedAccess.
  while (start < raw.length && ((raw[start] as number) & 0xC0) === 0x80) start += 1
  const tail = raw.subarray(start)
  return { text: tail.toString('utf8'), bytes: tail.length }
}

/**
 * One scope's contributions: the job controllers attached from it and the
 * completion, change, and record-output listeners registered there. All
 * tables are anonymous because a contribution is identified by its own
 * disposer, never by a name a second registrant could shadow.
 */
class JobLayer implements ScopeLayer {
  readonly controllers = new AnonymousEntries<symbol>()
  readonly listeners = new AnonymousEntries<JobDoneListener>()
  readonly changed = new AnonymousEntries<JobsChangedListener>()
  readonly output = new AnonymousEntries<JobOutputListener>()

  isEmpty(): boolean {
    return this.controllers.isEmpty() && this.listeners.isEmpty() && this.changed.isEmpty()
      && this.output.isEmpty()
  }
}

/**
 * The in-memory `jobs` registry. See the Service Definition contract in
 * `@deepseek-ai/dsh-jobs` for the ownership, isolation, and lifecycle
 * semantics this implementation honors.
 */
export class LocalJobRegistry extends JobRegistry {
  static Config: z<Config> = z.object({
    maxConcurrentJobsPerOwner: z.number()
      .step(1)
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(DEFAULT_MAX_CONCURRENT_TASKS_PER_OWNER),
    retainBytes: z.number()
      .step(1)
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(DEFAULT_RETAIN_BYTES),
    settledRetainBytes: z.number()
      .step(1)
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(DEFAULT_SETTLED_RETAIN_BYTES),
  })

  /** Schemastery-defaulted active-job limit. */
  private readonly maxConcurrentJobsPerOwner: number
  /** Schemastery-defaulted live record retention cap. */
  private readonly retainBytes: number
  /** Schemastery-defaulted settled record retention cap. */
  private readonly settledRetainBytes: number
  private store = new Map<JobId, TrackedTask>()
  private counters = new Map<string, number>()
  /**
   * Surfaces and listeners layered by the scope that registered them, in the
   * tools-registry shape: a contribution files into its registering context's
   * scope, and a read unions the global layer with the reader's scope chain.
   *
   * The registry is one process-wide instance serving every composition, so a
   * flat table would answer a per-owner question process-wide: one preset's
   * job controls would hold `start()` open for an agent whose own composition
   * loads none, and one settlement would reach every preset's notice listener.
   * Layers make both reads owner-relative. Nothing derives a cache from a
   * layer, so change notification is a no-op.
   */
  private readonly layers = new ScopedLayers<JobLayer>(() => new JobLayer(), () => {})
  private listenersClosed = false
  /** Owner agents with attached scope cleanup, mapped to the exact disposer. */
  private ownerCleanups = new Map<Agent, () => Promise<void> | void>()
  /** Service context used by detached settlement continuations and teardown. */
  private readonly selfCtx: Context

  constructor(ctx: Context, config: Config) {
    super(ctx)
    // Schemastery validates and fills the defaults before constructing the service.
    this.maxConcurrentJobsPerOwner = (config as Required<Config>).maxConcurrentJobsPerOwner
    this.retainBytes = (config as Required<Config>).retainBytes
    this.settledRetainBytes = (config as Required<Config>).settledRetainBytes
    this.selfCtx = ctx
    ctx.effect(() => () => this.disposeAll(), 'jobs teardown')
  }

  start(spec: JobStart): JobId {
    if (!this.servesOwner(spec.owner)) {
      throw new Error('background jobs unavailable: no job controller serves this agent (load @deepseek-ai/dsh-tool-jobs in its composition)')
    }
    if (spec.kind.length === 0) throw new Error('invalid job kind: expected a non-empty string')
    if (spec.label.length === 0) throw new Error('invalid job label: expected a non-empty string')
    if (spec.outputLimitBytes !== undefined
      && (!Number.isSafeInteger(spec.outputLimitBytes) || spec.outputLimitBytes <= 0)) {
      throw new Error(`invalid outputLimitBytes: expected a positive safe integer, got ${JSON.stringify(spec.outputLimitBytes)}`)
    }
    if (spec.owner !== undefined) this.ensureOwnerCleanup(spec.owner)

    const active = this.activeTaskCount(spec.owner)
    if (active >= this.maxConcurrentJobsPerOwner) {
      throw new Error(
        `background job limit reached for this owner (limit: ${this.maxConcurrentJobsPerOwner}); use job_kill to stop an unneeded job, wait for it to finish, then retry`,
      )
    }

    // The id is issued before the starter runs so the producer face can carry
    // it; a throwing starter still leaves nothing registered — its ordinal is
    // simply skipped.
    const count = (this.counters.get(spec.kind) ?? 0) + 1
    this.counters.set(spec.kind, count)
    const id = JobId(`${spec.kind}-${count}`)
    const state: ProducerState = { record: undefined, detail: undefined, job: undefined }
    const face: RunningJob = {
      id,
      updateDetail: (detail) => { this.updateDetail(state, detail) },
    }
    // The declaration decides the face: a plain start never receives `append`.
    const hooks = spec.record === true ? spec.run(this.recordingFace(face, state)) : spec.run(face)

    let markSettled!: () => void
    const settled = new Promise<void>((resolve) => { markSettled = resolve })
    const job: TrackedTask = {
      id,
      kind: spec.kind,
      label: spec.label,
      outputLimitBytes: spec.outputLimitBytes,
      owner: spec.owner,
      cancel: hooks.cancel.bind(hooks),
      readOutput: hooks.readOutput?.bind(hooks),
      status: 'running',
      state,
      output: undefined,
      startedAt: Date.now(),
      finishedAt: undefined,
      reported: false,
      killReason: undefined,
      settled,
      markSettled,
      waiters: 0,
      waitResolvers: new Set(),
    }
    // Binding the shared producer state is the commit: writes staged inside
    // the starter are already in `state`, and every later handle call reaches
    // the registered record for its terminal checks and observer signals.
    state.job = job
    this.store.set(id, job)

    void hooks.done.then(
      (outcome) => { this.settle(job, outcome) },
      (error: unknown) => {
        // Contain a producer contract violation (`done` rejected) so cleanup and waiters cannot hang.
        this.selfCtx.logger.warn(`jobs: job ${job.id} producer done promise rejected (producer contract violation): ${String(error)}`)
        this.settle(job, { status: 'failed', detail: String(error) })
      },
    )
    // Registration is complete and cannot fail from here, so the visible set
    // has genuinely changed.
    this.notifyChanged(job.owner)
    return id
  }

  list(caller?: Agent): JobSnapshot[] {
    const session = caller?.id
    return [...this.store.values()]
      .filter(job => job.owner === undefined || job.owner.id === session)
      .map(job => this.snapshot(job))
  }

  get(id: JobId, caller?: Agent): JobSnapshot {
    const job = this.expect(id)
    this.assertAccess(job, caller)
    return this.snapshot(job)
  }

  read(id: JobId, caller?: Agent): JobRead {
    const job = this.expect(id)
    this.assertAccess(job, caller)
    const text = job.readOutput !== undefined
      ? job.readOutput()
      : isTerminal(job.status) ? job.output ?? '' : ''
    if (isTerminal(job.status)) job.reported = true
    return { text, snapshot: this.snapshot(job) }
  }

  kill(id: JobId, caller?: Agent, options?: JobKillOptions): 'requested' | 'already-finished' {
    const job = this.expect(id)
    this.assertAccess(job, caller)
    // An unreporting kill never clears an existing claim, so `false` only
    // withholds this call's own claim rather than resurrecting a suppressed notice.
    const claims = options?.reported ?? true
    if (isTerminal(job.status)) {
      if (claims) job.reported = true
      return 'already-finished'
    }
    // Cancel first so a throw leaves both lifecycle and notice state unchanged.
    job.cancel(options?.reason)
    job.status = 'stopping'
    // Last writer wins on purpose: the detail reports the latest kill intent,
    // while `reported` above keeps first-claim-wins for notice delivery.
    if (options?.reason !== undefined) job.killReason = options.reason
    if (claims) job.reported = true
    this.notifyChanged(job.owner)
    return 'requested'
  }

  async wait(id: JobId, timeoutMs: number, caller?: Agent, signal?: AbortSignal): Promise<JobSnapshot> {
    const job = this.expect(id)
    this.assertAccess(job, caller)
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`invalid wait timeout: expected a positive number of milliseconds, got ${JSON.stringify(timeoutMs)}`)
    }
    if (!isTerminal(job.status)) {
      if (signal?.aborted) throw new Error('wait aborted')
      // Abort removes the waiter synchronously so same-tick settlement cannot
      // suppress a notice for a wait that will reject.
      job.waiters += 1
      let counted = true
      const uncount = (): void => {
        if (!counted) return
        counted = false
        job.waiters -= 1
      }
      try {
        // The scoped deadline distinguishes a successful wait timeout from
        // caller cancellation and clears its timer on every exit.
        using d = deadline(signal, timeoutMs, TASK_WAIT_TIMEOUT)
        await new Promise<void>((resolve, reject) => {
          const onSettled = (): void => {
            job.waitResolvers.delete(onSettled)
            d.signal.removeEventListener('abort', onAbort)
            resolve()
          }
          const onAbort = (): void => {
            job.waitResolvers.delete(onSettled)
            // A settled job cannot reach here: settlement releases every waiter
            // before it announces completion, and each released waiter detaches
            // this listener in the same synchronous span, so nothing that reacts
            // to a settlement can abort a wait the settlement already owed.
            if (timeoutOf(d.signal, TASK_WAIT_TIMEOUT) !== undefined) {
              resolve()
            } else {
              uncount()
              reject(new Error('wait aborted'))
            }
          }
          job.waitResolvers.add(onSettled)
          d.signal.addEventListener('abort', onAbort, { once: true })
        })
      } finally {
        uncount()
      }
    }
    if (isTerminal(job.status)) job.reported = true
    return this.snapshot(job)
  }

  onJobDone(listener: JobDoneListener): () => void {
    return this.layers.effect(
      this.ctx,
      layer => layer.listeners.append(listener),
      { label: 'jobs.onJobDone()' },
    )
  }

  onJobsChanged(listener: JobsChangedListener): () => void {
    return this.layers.effect(
      this.ctx,
      layer => layer.changed.append(listener),
      { label: 'jobs.onJobsChanged()' },
    )
  }

  readRecord(id: JobId, from: number, caller?: Agent): JobRecordRead {
    const job = this.expect(id)
    this.assertAccess(job, caller)
    if (!Number.isSafeInteger(from) || from < 0) {
      throw new Error(`invalid record read offset: expected a non-negative safe integer, got ${JSON.stringify(from)}`)
    }
    const record = job.state.record
    if (record === undefined) {
      throw new Error(`job ${job.id} declared no output record`)
    }
    const chunks: JobRecordChunk[] = []
    for (const chunk of record.chunks) {
      if (chunk.at + chunk.bytes <= from) continue
      chunks.push({
        at: chunk.at,
        text: chunk.text,
        ...chunk.channel !== undefined ? { channel: chunk.channel } : {},
        ...chunk.gapBefore !== undefined ? { gapBefore: chunk.gapBefore } : {},
      })
    }
    return { chunks, next: record.total, lossy: from < record.earliest }
  }

  onOutput(listener: JobOutputListener): () => void {
    return this.layers.effect(
      this.ctx,
      layer => layer.output.append(listener),
      { label: 'jobs.onOutput()' },
    )
  }

  attachController(name: string): () => void {
    // One token per call keeps duplicate labels independently disposable.
    const token = Symbol(name)
    return this.layers.effect(
      this.ctx,
      layer => layer.controllers.append(token),
      { label: 'jobs.attachController()' },
    )
  }

  /**
   * Whether an attached job controller can collect and stop work owned by
   * `owner`. The global layer holds every controller attached from an unscoped
   * context — a host composition's own controls — and therefore serves every
   * owner; a scoped controller serves exactly the agents composed under it.
   * @param owner - the job's owner, or undefined for unowned work.
   * @returns whether some reachable controller serves the owner.
   */
  private servesOwner(owner?: Agent): boolean {
    if (!this.layers.global.controllers.isEmpty()) return true
    return this.layers.chainLayers(owner === undefined ? undefined : scopeOf(owner.ctx))
      .some(layer => !layer.controllers.isEmpty())
  }

  /** Count authoritative active records for one exact owner or the shared unowned bucket. */
  private activeTaskCount(owner: Agent | undefined): number {
    let count = 0
    for (const job of this.store.values()) {
      if (job.owner === owner && (job.status === 'running' || job.status === 'stopping')) count += 1
    }
    return count
  }

  /**
   * The completion listeners that own `owner`'s notices: the global layer's
   * first, then each scoped layer along the owner's chain. A listener outside
   * that chain belongs to another composition and must not deliver, or the
   * owner reads one notice per mounted preset.
   * @param owner - the settled job's owner, or undefined for unowned work.
   * @returns the listeners to notify, in registration order per layer.
   */
  private *listenersFor(owner?: Agent): IterableIterator<JobDoneListener> {
    yield* this.layers.global.listeners.values()
    const scope = owner === undefined ? undefined : scopeOf(owner.ctx)
    for (const layer of this.layers.chainLayers(scope)) yield* layer.listeners.values()
  }

  /** Look up a job or fail loud. */
  private expect(id: JobId): TrackedTask {
    const job = this.store.get(id)
    if (job === undefined) throw new Error(`unknown job ${id}`)
    return job
  }

  /**
   * The isolation fence: a job with an owner is reachable only by callers
   * whose session id matches (`!== undefined` semantics — an unowned job is
   * open, and a no-agent caller can never match an owned one).
   */
  private assertAccess(job: TrackedTask, caller?: Agent): void {
    if (job.owner !== undefined && job.owner.id !== caller?.id) {
      throw new Error(`job ${job.id} belongs to another session`)
    }
  }

  /** Project a fresh read-only snapshot from the mutable record. */
  private snapshot(job: TrackedTask): JobSnapshot {
    const ownerSession = job.owner?.id
    const record = job.state.record
    return {
      id: job.id,
      kind: job.kind,
      label: job.label,
      ...job.outputLimitBytes !== undefined ? { outputLimitBytes: job.outputLimitBytes } : {},
      ...ownerSession !== undefined ? { ownerSession } : {},
      status: job.status,
      ...job.state.detail !== undefined ? { detail: job.state.detail } : {},
      startedAt: job.startedAt,
      ...job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {},
      reported: job.reported,
      ...record !== undefined ? { outputTotal: record.total, outputEarliest: record.earliest } : {},
    }
  }

  /**
   * The change observers that own `owner`'s updates, resolved exactly like
   * {@link listenersFor}: the global layer — a host composition's own carrier,
   * which serves every owner — then each scoped layer along the owner's chain.
   * An observer outside that chain belongs to another composition and would
   * otherwise be told about agents it does not compose.
   * @param owner - the owner whose visible set moved, or undefined for unowned work.
   * @returns the observers to notify, in registration order per layer.
   */
  private *changedFor(owner?: Agent): IterableIterator<JobsChangedListener> {
    yield* this.layers.global.changed.values()
    const scope = owner === undefined ? undefined : scopeOf(owner.ctx)
    for (const layer of this.layers.chainLayers(scope)) yield* layer.changed.values()
  }

  /**
   * Announce that one owner's visible set changed. Each listener is contained
   * so an observer cannot break a lifecycle commit that already happened.
   */
  private notifyChanged(owner: Agent | undefined): void {
    for (const listener of this.changedFor(owner)) {
      try {
        listener(owner)
      } catch (error: unknown) {
        this.selfCtx.logger.warn(`jobs: onJobsChanged listener threw: ${String(error)}`)
      }
    }
  }

  /** The record-output observers that own `owner`'s stream signals, resolved like {@link changedFor}. */
  private *outputFor(owner?: Agent): IterableIterator<JobOutputListener> {
    yield* this.layers.global.output.values()
    const scope = owner === undefined ? undefined : scopeOf(owner.ctx)
    for (const layer of this.layers.chainLayers(scope)) yield* layer.output.values()
  }

  /** Announce that one job's record advanced (append or settlement), with per-listener containment. */
  private notifyOutput(job: TrackedTask): void {
    for (const listener of this.outputFor(job.owner)) {
      try {
        listener(job.id)
      } catch (error: unknown) {
        this.selfCtx.logger.warn(`jobs: onOutput listener threw: ${String(error)}`)
      }
    }
  }

  /** Install the job's record and extend the producer face with its append. */
  private recordingFace(face: RunningJob, state: ProducerState): RecordingJob {
    const record: RecordState = { chunks: [], retainedBytes: 0, total: 0, earliest: 0 }
    state.record = record
    return {
      ...face,
      append: (text, options) => { this.appendRecord(state, record, text, options) },
    }
  }

  /**
   * Append one chunk through a recording producer face. A chunk against a
   * settled job is logged and dropped; an empty chunk is dropped silently. A
   * chunk staged inside the starter call is retained and signals no observer —
   * the registration commit publishes it.
   */
  private appendRecord(state: ProducerState, record: RecordState, text: string, options?: JobAppendOptions): void {
    const job = state.job
    if (job !== undefined && isTerminal(job.status)) {
      this.selfCtx.logger.warn(`jobs: append to settled job ${job.id} dropped`)
      return
    }
    if (text.length === 0) return
    const bytes = Buffer.byteLength(text, 'utf8')
    record.chunks.push({
      at: record.total,
      text,
      bytes,
      ...options?.channel !== undefined ? { channel: options.channel } : {},
      ...options?.gapBefore !== undefined ? { gapBefore: options.gapBefore } : {},
    })
    record.total += bytes
    record.retainedBytes += bytes
    this.trimRecord(record, this.retainBytes)
    if (job !== undefined) this.notifyOutput(job)
  }

  /**
   * Replace the live detail line through a producer face; a write against a
   * settled job is logged and dropped. A write staged inside the starter call
   * seeds the registered snapshot and signals no observer.
   */
  private updateDetail(state: ProducerState, detail: string): void {
    const job = state.job
    if (job !== undefined && isTerminal(job.status)) {
      this.selfCtx.logger.warn(`jobs: detail update on settled job ${job.id} dropped`)
      return
    }
    state.detail = detail
    if (job !== undefined) this.notifyChanged(job.owner)
  }

  /**
   * Drop retained head chunks until the ring fits `cap`; a single oversized
   * chunk keeps only its UTF-8-safe tail with a `gapBefore` marker. Offsets
   * stay absolute: `earliest` advances over everything dropped.
   */
  private trimRecord(record: RecordState, cap: number): void {
    while (record.retainedBytes > cap && record.chunks.length > 1) {
      const dropped = record.chunks.shift()
      /* v8 ignore next -- the length guard proves shift() returns a chunk; the check only satisfies noUncheckedIndexedAccess. */
      if (dropped === undefined) break
      record.retainedBytes -= dropped.bytes
    }
    const single = record.chunks.length === 1 ? record.chunks[0] : undefined
    if (single !== undefined && single.bytes > cap) {
      const tail = utf8Tail(single.text, cap)
      single.at += single.bytes - tail.bytes
      single.text = tail.text
      single.bytes = tail.bytes
      single.gapBefore = true
      record.retainedBytes = tail.bytes
    }
    record.earliest = record.chunks[0]?.at ?? record.total
  }

  /**
   * Record the first terminal outcome, release waiters, then announce
   * completion. First-wins preserves a teardown force-failure against late
   * producer settlement. Pending waits mark the job reported before listeners
   * run. Completion is announced last because a reporter may open a model turn
   * synchronously: every other observer of this settlement must already have
   * seen the committed record.
   */
  private settle(job: TrackedTask, outcome: JobOutcome): void {
    if (isTerminal(job.status)) return
    job.status = outcome.status
    // A killed settlement carries the recorded kill reason in its detail:
    // producer facts first (`signal: SIGTERM; cancelled by the user`). A job
    // that outran its kill request (settled `completed`/`failed`) keeps the
    // producer detail alone — the reason describes a kill that never landed.
    // Without any terminal detail the last live progress line stays, still
    // describing what the job was doing.
    if (outcome.status === 'killed' && job.killReason !== undefined) {
      job.state.detail = outcome.detail !== undefined
        ? `${outcome.detail}; ${job.killReason}`
        : job.killReason
    } else if (outcome.detail !== undefined) {
      job.state.detail = outcome.detail
    }
    job.output = outcome.output
    job.finishedAt = Date.now()
    if (job.waiters > 0) job.reported = true
    // Settlement ends the record: trim to the settled cap before any observer
    // reads the terminal snapshot.
    const record = job.state.record
    if (record !== undefined) this.trimRecord(record, this.settledRetainBytes)
    const snapshot = this.snapshot(job)
    const waitResolvers = [...job.waitResolvers]
    job.waitResolvers.clear()
    for (const resolveWait of waitResolvers) resolveWait()
    job.markSettled()
    this.notifyChanged(job.owner)
    // The record stream ends with settlement; the signal follows the committed
    // visible-set change and precedes completion listeners, which stay last.
    if (record !== undefined) this.notifyOutput(job)
    if (this.listenersClosed) return
    for (const listener of this.listenersFor(job.owner)) {
      try {
        const returned = listener(snapshot, job.owner)
        void Promise.resolve(returned).catch((error: unknown) => {
          this.selfCtx.logger.warn(`jobs: onJobDone listener rejected for ${job.id}: ${String(error)}`)
        })
      } catch (error: unknown) {
        this.selfCtx.logger.warn(`jobs: onJobDone listener threw for ${job.id}: ${String(error)}`)
      }
    }
  }

  /**
   * Attach one awaited cleanup through the exact owner's scope. This survives
   * producer reloads and joins agent quiescence; the retained disposer lets
   * service teardown detach the cross-fiber effect. Fails when the registry is
   * absent or the owner is not its currently registered instance.
   */
  private ensureOwnerCleanup(owner: Agent): void {
    const ownerId = owner.id
    const agents = this.selfCtx.get('agents')
    if (agents === undefined) {
      throw new Error('background job ownership requires the agent registry (load @deepseek-ai/dsh-agent)')
    }
    if (agents.get(ownerId) !== owner) {
      throw new Error(`agent "${ownerId}" is not the registered agent instance (background job owner must be live)`)
    }
    if (this.ownerCleanups.has(owner)) return
    // Record only after attach succeeds; a disposing scope rejects new effects.
    const detach = owner.ctx.effect(() => async () => {
      this.ownerCleanups.delete(owner)
      await this.disposeOwned(owner)
    }, 'jobs.ownerCleanup()')
    this.ownerCleanups.set(owner, detach)
  }

  /** Cancel, await terminal records, and drop every job owned by one exact agent lifecycle. */
  private async disposeOwned(owner: Agent): Promise<void> {
    const owned = [...this.store.values()].filter(job => job.owner === owner)
    this.cancelForTeardown(owned, 'owner disposed')
    await Promise.all(owned.map(job => job.settled))
    for (const job of owned) this.store.delete(job.id)
    // Removal is the one visible-set change no per-job record carries, so it
    // must be announced here or an observer keeps the dropped rows forever.
    if (owned.length > 0) this.notifyChanged(owner)
  }

  /**
   * Close listeners, cancel live jobs, await settlement, and detach owner
   * effects. Throwing cancels are force-failed to avoid teardown deadlock.
   */
  private async disposeAll(): Promise<void> {
    // The flag is the whole guard: each layer entry's undo belongs to the fiber
    // that registered it, so this service may not drop them on its own way out.
    this.listenersClosed = true
    const all = [...this.store.values()]
    this.cancelForTeardown(all, 'jobs service disposed')
    await Promise.all(all.map(job => job.settled))
    // Distinct owners whose records just disappeared. A change observer files
    // into the layer of the context that registered it, so a consumer mounted
    // outside this service — the api-proxy carrier registers from the mux
    // stream — is still reachable here. Without this it keeps the rows it last
    // received after a registry reload.
    const emptied = new Set(all.map(job => job.owner))
    this.store.clear()
    for (const owner of emptied) this.notifyChanged(owner)
    // Detach cross-fiber owner effects after the shared store is quiescent.
    const ownerCleanups = [...this.ownerCleanups.values()]
    this.ownerCleanups.clear()
    await Promise.all(ownerCleanups.map(cleanup => Promise.resolve(cleanup())))
  }

  /**
   * Cancel jobs during teardown with per-job containment. A throwing cancel
   * force-fails the record and reports a possible orphan; a cancel that returns
   * without settling remains indistinguishable from a slow stop and may stall.
   */
  private cancelForTeardown(jobs: TrackedTask[], reason: string): void {
    for (const job of jobs) {
      if (isTerminal(job.status)) continue
      // Teardown cancellation is a kill without a caller, so it claims the
      // terminal report the same way `kill()` does. Nothing will read a notice
      // for a job whose owner or service is being destroyed, and a waking
      // reporter would spend a model request per teardown layer. This is
      // decided before the producer runs: the force-failure below settles the
      // record too, so a throwing cancel must not be the one path that
      // announces an unreported completion into a disposing owner.
      job.reported = true
      try {
        job.cancel(reason)
        job.status = 'stopping'
        // Teardown reaches settlement only after the producer releases, which a
        // slow stop can defer; announcing the transition here is what keeps an
        // observer from showing `running` for that whole window.
        this.notifyChanged(job.owner)
      } catch (error: unknown) {
        const detail = `cancel threw during teardown; work may be orphaned: ${String(error)}`
        this.selfCtx.logger.warn(`jobs: cancel of ${job.id} threw during teardown; job record forced failed and work may be orphaned: ${String(error)}`)
        this.settle(job, { status: 'failed', detail })
      }
    }
  }
}

export default LocalJobRegistry
