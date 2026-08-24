/**
 * Process-local provider for the streaming-output observation seam
 * (`ctx.activities`). It keeps every record and its bounded output ring in
 * memory and hands out fresh snapshots and chunk copies, never live state.
 *
 * Records outlive producer fibers. Owner disposal ends still-open records and
 * removes them; service disposal ends and clears everything. Neither awaits a
 * producer — the registry owns no execution resource.
 * @module @deepseek-ai/dsh-activity-local
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AnonymousEntries, ScopedLayers, scopeOf } from '@deepseek-ai/dsh-scope'
import type { ScopeLayer } from '@deepseek-ai/dsh-scope'
import { ActivityRegistry, ActivityId } from '@deepseek-ai/dsh-activity'
import type {
  ActivityAppendOptions, ActivityChannel, ActivityCorrelation, ActivitiesChangedListener,
  ActivityHandle, ActivityKind, ActivityOpen, ActivityOutcome, ActivityOutputChunk,
  ActivityOutputListener, ActivityRead, ActivitySnapshot, ActivityStatus,
} from '@deepseek-ai/dsh-activity'

/** Default live retention per activity, in UTF-8 bytes. */
const DEFAULT_RETAIN_BYTES = 256 * 1024

/** Default retention kept after settlement, in UTF-8 bytes. */
const DEFAULT_SETTLED_RETAIN_BYTES = 16 * 1024

/** Configuration for the process-local observation registry. */
export interface Config {
  /** Live output retention per activity in UTF-8 bytes; omission defaults to 262144. */
  retainBytes?: number
  /** Output retention kept after an activity settles, in UTF-8 bytes; omission defaults to 16384. */
  settledRetainBytes?: number
}

/** The registry's mutable per-activity record (never handed out — see {@link LocalActivityRegistry.snapshot}). */
interface TrackedActivity {
  id: ActivityId
  kind: ActivityKind
  label: string
  /** Exact lifecycle owner; session-id visibility is derived from it. */
  owner: Agent | undefined
  correlation: ActivityCorrelation | undefined
  status: ActivityStatus
  detail: string | undefined
  startedAt: number
  finishedAt: number | undefined
  /** Retained chunks in offset order; offsets stay absolute across eviction. */
  chunks: RingChunk[]
  /** Sum of the retained chunks' byte lengths. */
  retainedBytes: number
  /** Total UTF-8 bytes ever appended. */
  total: number
  /** Offset of the oldest retained byte (equals {@link total} when nothing is retained). */
  earliest: number
}

/** One retained ring entry; `bytes` caches the chunk's UTF-8 length. */
interface RingChunk {
  at: number
  text: string
  bytes: number
  channel?: ActivityChannel
  gapBefore?: true
}

/** True for the three terminal {@link ActivityStatus} values. */
function isTerminal(status: ActivityStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
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
 * One scope's observer contributions. Both tables are anonymous because a
 * contribution is identified by its own disposer, never by a name a second
 * registrant could shadow.
 */
class ActivityLayer implements ScopeLayer {
  readonly changed = new AnonymousEntries<ActivitiesChangedListener>()
  readonly output = new AnonymousEntries<ActivityOutputListener>()

  isEmpty(): boolean {
    return this.changed.isEmpty() && this.output.isEmpty()
  }
}

/**
 * The in-memory `activities` registry. See the Service Definition contract in
 * `@deepseek-ai/dsh-activity` for the observation, retention, and lifecycle
 * semantics this implementation honors.
 */
export class LocalActivityRegistry extends ActivityRegistry {
  static Config: z<Config> = z.object({
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

  /** Schemastery-defaulted live retention cap. */
  private readonly retainBytes: number
  /** Schemastery-defaulted settled retention cap. */
  private readonly settledRetainBytes: number
  private store = new Map<ActivityId, TrackedActivity>()
  private counters = new Map<string, number>()
  /**
   * Observers layered by the scope that registered them, in the jobs-registry
   * shape: a contribution files into its registering context's scope, and a
   * dispatch unions the global layer with the subject owner's scope chain, so
   * delivery stays owner-relative in one process-wide registry. Nothing
   * derives a cache from a layer, so change notification is a no-op.
   */
  private readonly layers = new ScopedLayers<ActivityLayer>(() => new ActivityLayer(), () => {})
  /** Owner agents with attached scope cleanup, mapped to the exact disposer. */
  private ownerCleanups = new Map<Agent, () => Promise<void> | void>()
  /** Service context used by contained listener reporting and teardown. */
  private readonly selfCtx: Context

  constructor(ctx: Context, config: Config) {
    super(ctx)
    // Schemastery validates and fills the defaults before constructing the service.
    this.retainBytes = (config as Required<Config>).retainBytes
    this.settledRetainBytes = (config as Required<Config>).settledRetainBytes
    this.selfCtx = ctx
    ctx.effect(() => () => { this.disposeAll() }, 'activities teardown')
  }

  open(spec: ActivityOpen): ActivityHandle {
    if (spec.kind.length === 0) throw new Error('invalid activity kind: expected a non-empty string')
    if (spec.label.length === 0) throw new Error('invalid activity label: expected a non-empty string')
    if (spec.owner !== undefined) this.ensureOwnerCleanup(spec.owner)

    const count = (this.counters.get(spec.kind) ?? 0) + 1
    this.counters.set(spec.kind, count)
    const id = ActivityId(`${spec.kind}-${count}`)
    const record: TrackedActivity = {
      id,
      kind: spec.kind,
      label: spec.label,
      owner: spec.owner,
      correlation: spec.correlation === undefined ? undefined : { ...spec.correlation },
      status: 'running',
      detail: undefined,
      startedAt: Date.now(),
      finishedAt: undefined,
      chunks: [],
      retainedBytes: 0,
      total: 0,
      earliest: 0,
    }
    this.store.set(id, record)
    // Registration is complete and cannot fail from here, so the visible set
    // has genuinely changed.
    this.notifyChanged(record.owner)
    return {
      id,
      append: (text, options) => { this.append(record, text, options) },
      updateDetail: (detail) => { this.updateDetail(record, detail) },
      end: (outcome) => { this.settle(record, outcome) },
    }
  }

  list(caller?: Agent): ActivitySnapshot[] {
    const session = caller?.id
    return [...this.store.values()]
      .filter(record => record.owner === undefined || record.owner.id === session)
      .map(record => this.snapshot(record))
  }

  get(id: ActivityId, caller?: Agent): ActivitySnapshot {
    const record = this.expect(id)
    this.assertAccess(record, caller)
    return this.snapshot(record)
  }

  read(id: ActivityId, from: number, caller?: Agent): ActivityRead {
    const record = this.expect(id)
    this.assertAccess(record, caller)
    if (!Number.isSafeInteger(from) || from < 0) {
      throw new Error(`invalid read offset: expected a non-negative safe integer, got ${JSON.stringify(from)}`)
    }
    const chunks: ActivityOutputChunk[] = []
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

  onActivitiesChanged(listener: ActivitiesChangedListener): () => void {
    return this.layers.effect(
      this.ctx,
      layer => layer.changed.append(listener),
      { label: 'activities.onActivitiesChanged()' },
    )
  }

  onOutput(listener: ActivityOutputListener): () => void {
    return this.layers.effect(
      this.ctx,
      layer => layer.output.append(listener),
      { label: 'activities.onOutput()' },
    )
  }

  /** Append one chunk to a live record; log and drop on an ended one. */
  private append(record: TrackedActivity, text: string, options?: ActivityAppendOptions): void {
    if (isTerminal(record.status)) {
      this.selfCtx.logger.warn(`activities: append to ended activity ${record.id} dropped`)
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
    this.trim(record, this.retainBytes)
    this.notifyOutput(record)
  }

  /** Replace a live record's detail line; log and drop on an ended one. */
  private updateDetail(record: TrackedActivity, detail: string): void {
    if (isTerminal(record.status)) {
      this.selfCtx.logger.warn(`activities: detail update on ended activity ${record.id} dropped`)
      return
    }
    record.detail = detail
    this.notifyChanged(record.owner)
  }

  /**
   * Record the first terminal outcome, trim retention to the settled cap, and
   * announce the change and the stream end. First-wins: a later call — the
   * producer's own report after a teardown force-end, or a duplicate — is
   * dropped silently.
   */
  private settle(record: TrackedActivity, outcome: ActivityOutcome): void {
    if (isTerminal(record.status)) return
    record.status = outcome.status
    if (outcome.detail !== undefined) record.detail = outcome.detail
    record.finishedAt = Date.now()
    this.trim(record, this.settledRetainBytes)
    this.notifyChanged(record.owner)
    this.notifyOutput(record)
  }

  /**
   * Drop retained head chunks until the ring fits `cap`; a single oversized
   * chunk keeps only its UTF-8-safe tail with a `gapBefore` marker. Offsets
   * stay absolute: `earliest` advances over everything dropped.
   */
  private trim(record: TrackedActivity, cap: number): void {
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

  /** Look up an activity or fail loud. */
  private expect(id: ActivityId): TrackedActivity {
    const record = this.store.get(id)
    if (record === undefined) throw new Error(`unknown activity ${id}`)
    return record
  }

  /**
   * The visibility fence: an activity with an owner is reachable only by
   * callers whose session id matches (`!== undefined` semantics — an unowned
   * activity is open, and a no-agent caller can never match an owned one).
   */
  private assertAccess(record: TrackedActivity, caller?: Agent): void {
    if (record.owner !== undefined && record.owner.id !== caller?.id) {
      throw new Error(`activity ${record.id} belongs to another session`)
    }
  }

  /** Project a fresh read-only snapshot from the mutable record. */
  private snapshot(record: TrackedActivity): ActivitySnapshot {
    const ownerSession = record.owner?.id
    return {
      id: record.id,
      kind: record.kind,
      label: record.label,
      ...ownerSession !== undefined ? { ownerSession } : {},
      ...record.correlation !== undefined ? { correlation: { ...record.correlation } } : {},
      status: record.status,
      ...record.detail !== undefined ? { detail: record.detail } : {},
      startedAt: record.startedAt,
      ...record.finishedAt !== undefined ? { finishedAt: record.finishedAt } : {},
      outputTotal: record.total,
      outputEarliest: record.earliest,
    }
  }

  /**
   * The change observers that own `owner`'s updates: the global layer — a
   * host composition's own carrier, which serves every owner — then each
   * scoped layer along the owner's chain.
   */
  private *changedFor(owner?: Agent): IterableIterator<ActivitiesChangedListener> {
    yield* this.layers.global.changed.values()
    const scope = owner === undefined ? undefined : scopeOf(owner.ctx)
    for (const layer of this.layers.chainLayers(scope)) yield* layer.changed.values()
  }

  /** The output observers that own `owner`'s stream signals, resolved like {@link changedFor}. */
  private *outputFor(owner?: Agent): IterableIterator<ActivityOutputListener> {
    yield* this.layers.global.output.values()
    const scope = owner === undefined ? undefined : scopeOf(owner.ctx)
    for (const layer of this.layers.chainLayers(scope)) yield* layer.output.values()
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
        this.selfCtx.logger.warn(`activities: onActivitiesChanged listener threw: ${String(error)}`)
      }
    }
  }

  /** Announce that one activity's stream advanced (append or settlement), with per-listener containment. */
  private notifyOutput(record: TrackedActivity): void {
    for (const listener of this.outputFor(record.owner)) {
      try {
        listener(record.id)
      } catch (error: unknown) {
        this.selfCtx.logger.warn(`activities: onOutput listener threw: ${String(error)}`)
      }
    }
  }

  /**
   * Attach one cleanup through the exact owner's scope. This survives
   * producer reloads; the retained disposer lets service teardown detach the
   * cross-fiber effect. Fails when the agent registry is absent or the owner
   * is not its currently registered instance.
   */
  private ensureOwnerCleanup(owner: Agent): void {
    const ownerId = owner.id
    const agents = this.selfCtx.get('agents')
    if (agents === undefined) {
      throw new Error('activity ownership requires the agent registry (load @deepseek-ai/dsh-agent)')
    }
    if (agents.get(ownerId) !== owner) {
      throw new Error(`agent "${ownerId}" is not the registered agent instance (activity owner must be live)`)
    }
    if (this.ownerCleanups.has(owner)) return
    // Record only after attach succeeds; a disposing scope rejects new effects.
    const detach = owner.ctx.effect(() => () => {
      this.ownerCleanups.delete(owner)
      this.disposeOwned(owner)
    }, 'activities.ownerCleanup()')
    this.ownerCleanups.set(owner, detach)
  }

  /** End still-open records and drop every activity owned by one exact agent lifecycle. */
  private disposeOwned(owner: Agent): void {
    const owned = [...this.store.values()].filter(record => record.owner === owner)
    for (const record of owned) {
      if (!isTerminal(record.status)) this.settle(record, { status: 'killed', detail: 'owner disposed' })
      this.store.delete(record.id)
    }
    // Removal is the one visible-set change no per-activity record carries, so
    // it must be announced here or an observer keeps the dropped rows forever.
    if (owned.length > 0) this.notifyChanged(owner)
  }

  /** End every open record, clear the store, and announce each emptied owner. */
  private disposeAll(): void {
    const all = [...this.store.values()]
    for (const record of all) {
      if (!isTerminal(record.status)) this.settle(record, { status: 'killed', detail: 'activity registry disposed' })
    }
    const emptied = new Set(all.map(record => record.owner))
    this.store.clear()
    for (const owner of emptied) this.notifyChanged(owner)
    // Detach cross-fiber owner effects after the shared store is quiescent.
    const ownerCleanups = [...this.ownerCleanups.values()]
    this.ownerCleanups.clear()
    for (const cleanup of ownerCleanups) void cleanup()
  }
}

export default LocalActivityRegistry
