/**
 * Persisted projection cache (`ctx.sessionProjectionCache`): durable
 * checkpoints of every projection unit's state, one `projection_cache.json`
 * per session under the cache's own storage root (`<root>/<session-id>/
 * projection_cache.json`). The cache owns its directory tree and never
 * consults the persistence layer. The cache is a fold shortcut, never an
 * authority: a row
 * is possibly stale (its `seq` says how stale) but never wrong, so every
 * write path is fail-soft (a lost write costs a longer tail replay on the
 * next cold read) and a `ver` mismatch discards the row instead of migrating
 * it. Design authority: the session-projection RFC
 * (.agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.md).
 * @module @deepseek-ai/dsh-session-projection-cache
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { ProjectionCheckpoint, ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import { checkpointRecord } from './spec.ts'
import type { CheckpointIdentity, CheckpointRecord } from './spec.ts'

export { checkpointIdentity, checkpointRecord, checkpointRow } from './spec.ts'
export type { CheckpointIdentity, CheckpointRecord } from './spec.ts'

/** Cache file name inside each session's own persistence directory. */
const CACHE_FILE_NAME = 'projection_cache.json'
/** Owner-only cache files and session directories: the session tree is private data. */
const CACHE_FILE_MODE = 0o600
const CACHE_DIR_MODE = 0o700

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionProjectionCache: SessionProjectionCache
  }
}

/**
 * Plugin config. Both throttle triggers are deployment choices with no
 * universally correct value, so the composition states them explicitly
 * (cordis.yml); the two mandatory write points (`turn/end` and session
 * disposal) are policy, not tunables, and always fire.
 */
export interface Config {
  /** Directory holding one `<session-id>/projection_cache.json` per session. */
  root: string
  /** Committed events per session that force a durable checkpoint write between mandatory points. */
  writeEveryEvents: number
  /** Longest time (milliseconds) a dirty checkpoint may stay unwritten between mandatory points. */
  writeIntervalMs: number
}

export const Config: z<Config> = z.object({
  root: z.string().required(),
  writeEveryEvents: z.natural().min(1).required(),
  writeIntervalMs: z.natural().min(1).required(),
})

/** Per-session write-behind bookkeeping (live sessions only; dropped at retire). */
interface DirtyState {
  /** Committed events since the last durable write. */
  pending: number
  /** Interval trigger armed at the first dirty event after a clean write. */
  timer: ReturnType<typeof setTimeout> | undefined
}

/**
 * The persisted projection cache service. Checkpoints live sessions on a
 * throttled write-behind (count/interval triggers from {@link Config}) plus
 * two mandatory points — `turn/end` and session disposal (the live-to-cold
 * moment) — and serves the cached rows for a session header. Every durable
 * write is fail-soft: failures log a warning and the cache self-heals on the
 * next write. The cache owns its directory tree and never consults the
 * persistence layer.
 */
export class SessionProjectionCache extends Service {
  static inject = ['sessionProjections', 'sessions']

  static Config: z<Config> = Config

  private readonly dirty = new Map<Session, DirtyState>()
  /** Serialize atomic replacements per cache path so an older cut never overwrites a newer one. */
  private readonly writeChains = new Map<string, Promise<void>>()
  /** In-flight durable writes, drained on service disposal. */
  private readonly inFlight = new Set<Promise<unknown>>()

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'sessionProjectionCache')
  }

  /** Install the write-behind listeners. */
  protected async [Service.init](): Promise<void> {
    this.installWritePath()
  }

  /**
   * Resolve one session's cache file path. The cache owns the layout: a
   * per-session directory under the configured root, keyed by the session id
   * (a code-generated string, safe as a path segment). No persistence
   * lookup — the path is a pure function of the header.
   * @param meta - the session header naming the cache entry.
   * @returns the absolute cache-file path.
   */
  private cachePathFor(meta: SessionHeader): string {
    return join(this.config.root, meta.id, CACHE_FILE_NAME)
  }

  /**
   * Read and validate one session's stored record, accepted only when its
   * bound log identity matches `expected`. A session id names a slot, not a
   * lifecycle: a recreated id or a persistence store swapped under a
   * surviving cache must not let an old record seed state folded from an
   * unrelated log. Fail-soft — an absent, unreadable, or malformed file
   * reads as "no cache row".
   * @param meta - the session header locating the file.
   * @param expected - the log identity the caller holds (live or stored header).
   * @returns the identity-matching record, or `undefined`.
   */
  private async recordFor(meta: SessionHeader, expected: CheckpointIdentity): Promise<CheckpointRecord | undefined> {
    try {
      const record = checkpointRecord.parse(JSON.parse(await readFile(this.cachePathFor(meta), 'utf8')))
      return identityMatches(record.identity, expected) ? record : undefined
    } catch {
      // An absent, unreadable, or malformed file reads as "no cache row";
      // the caller refolds from the log. Identity mismatch is a normal
      // ternary return above, not an exception.
      return undefined
    }
  }

  /**
   * The listing read: whole values viewed straight from the stored rows
   * (version-matching keys only), each cut carried with its watermark so a
   * client value store can seed under its higher-seq-wins rule — as stale as
   * the last durable checkpoint but never wrong, and never from an unrelated
   * log (the caller's header is the identity witness).
   * @param meta - the listed session's header (identity witness; no log read).
   * @returns the cut (`asOfSeq` = lowest served-row watermark), or
   *   `undefined` when no usable row exists for this lifecycle.
   */
  async cachedSnapshot(meta: SessionHeader): Promise<ProjectionSnapshot | undefined> {
    const record = await this.recordFor(meta, identityOf(meta))
    if (record === undefined) return undefined
    const values = this.ctx.sessionProjections.viewCheckpoint(record.rows)
    const keys = Object.keys(values)
    if (keys.length === 0) return undefined
    // The block carries ONE cut: the lowest served watermark is the seq every
    // value is at least current as of (under-claiming is safe under
    // higher-seq-wins; over-claiming would let a stale value outrank pushes).
    const asOfSeq = Math.min(...keys.map(key => (record.rows[key] as { seq: number }).seq))
    return { asOfSeq, values }
  }

  /**
   * Durably checkpoint one live session NOW (both mandatory points call
   * this; tests and carriers may too). The registry cut is snapshotted at
   * this boundary (states are live references), then the session's cache
   * file is replaced. NOT fail-soft — callers on the fail-soft paths contain
   * it.
   * @param session - the live session to checkpoint.
   * @returns resolution after durability and event emission.
   */
  async write(session: Session): Promise<void> {
    const path = this.cachePathFor(session.header)
    const rows = this.ctx.sessionProjections.checkpoint(session)
    this.markClean(session)
    // Durability barrier: the checkpoint cut was taken above, so flushing
    // AFTER it guarantees every event inside the cut is durably logged
    // before the cache file lands — a crash can leave the cache behind the
    // log (longer tail replay) but never ahead of it (phantom values folded
    // from events no stored log contains). At detach the store entry is
    // already gone; persistence's own retirement drain covers that path and
    // any residual overreach is caught by the cold read's anchored floor.
    if (this.ctx.sessions.get(session.id) === session) await this.ctx.sessions.flush(session)
    await this.put(path, identityOf(session.header), rows)
  }

  // --- write-behind (throttle + mandatory points) ---

  private installWritePath(): void {
    // Every committed event advances the dirty counter; turn/end is a
    // mandatory point (the durable value most reads want is the turn-final
    // one), count/interval throttle the in-turn stream.
    this.ctx.on('session/event', (session: Session, event: SessionEvent) => {
      if (event.type === 'turn/end') {
        void this.flushSoft(session, 'turn/end')
        return
      }
      const state = this.dirty.get(session) ?? { pending: 0, timer: undefined }
      this.dirty.set(session, state)
      state.pending += 1
      if (state.pending >= this.config.writeEveryEvents) {
        void this.flushSoft(session, 'count threshold')
        return
      }
      state.timer ??= setTimeout(() => {
        void this.flushSoft(session, 'interval')
      }, this.config.writeIntervalMs)
    })

    // Detach (the live-to-cold moment): the second mandatory point. After
    // this write the cold-read ladder serves the session from the cache.
    // flushSoft's synchronous prefix reads and resets the dirty state, so
    // dropping it (timer already cleared by markClean) right after is safe.
    this.ctx.on('session/disposed', (session: Session) => {
      void this.flushSoft(session, 'detach')
      this.markClean(session)
      this.dirty.delete(session)
    })

    // With the plugin (their sessions outlive the cache): clear pending
    // timers, stop accepting new work, and drain in-flight durable writes so
    // a late flush can never land after disposal (or overwrite a successor).
    this.ctx.effect(() => () => {
      for (const state of this.dirty.values()) {
        if (state.timer !== undefined) clearTimeout(state.timer)
      }
      this.dirty.clear()
      return Promise.allSettled([...this.inFlight])
    }, 'sessionProjectionCache.timers')
  }

  /**
   * One fail-soft durable checkpoint. Every caller has work by construction:
   * the throttle triggers only fire dirty (markClean clears the timer with
   * the counter) and the two mandatory points write unconditionally.
   */
  private async flushSoft(session: Session, trigger: string): Promise<void> {
    const run = (async () => {
      try {
        await this.write(session)
      } catch (error) {
        this.ctx.logger.warn(`session projection cache: ${trigger} write for "${session.id}" failed (cache stays stale): ${String(error)}`)
      }
    })()
    this.inFlight.add(run)
    void run.finally(() => this.inFlight.delete(run))
  }

  /** Reset one session's dirty bookkeeping (its checkpoint is being written). */
  private markClean(session: Session): void {
    const state = this.dirty.get(session)
    if (state === undefined) return
    state.pending = 0
    if (state.timer !== undefined) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
  }

  /**
   * Atomically replace one session's cache file with its log identity and a
   * detached snapshot of `rows`, serialized per path so concurrent checkpoints
   * land in call order (a stale cut can never overwrite a newer one).
   */
  private put(path: string, identity: CheckpointIdentity, rows: ProjectionCheckpoint): Promise<void> {
    const detached = snapshotJsonValue(rows)
    if (detached === undefined) {
      throw new TypeError('projection checkpoint is not losslessly JSON-serializable (a unit state violates the plain-JSON contract)')
    }
    const record: CheckpointRecord = { identity, rows: detached as CheckpointRecord['rows'] }
    const previous = this.writeChains.get(path) ?? Promise.resolve()
    const next = previous.then(() => writeFileAtomic(
      path,
      JSON.stringify(record, null, 2),
      { mode: CACHE_FILE_MODE, dirMode: CACHE_DIR_MODE },
    ))
    void next.finally(() => {
      if (this.writeChains.get(path) === next) this.writeChains.delete(path)
    }).catch(() => {
      // The chain cleanup must run on failure too; the write rejection
      // itself is `next`'s, observed by the caller awaiting `put`.
    })
    this.writeChains.set(path, next)
    return next
  }
}

/** Project a header onto the identity fields a record is bound to. */
function identityOf(header: SessionHeader): CheckpointIdentity {
  return { createdAt: header.createdAt, ...header.cwd === undefined ? {} : { cwd: header.cwd } }
}

/** Whether a stored record's bound identity names the caller's lifecycle. */
function identityMatches(stored: CheckpointIdentity, expected: CheckpointIdentity): boolean {
  return stored.createdAt === expected.createdAt && stored.cwd === expected.cwd
}

export default SessionProjectionCache
