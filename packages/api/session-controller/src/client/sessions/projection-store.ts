/**
 * Generic per-session projection value store (push model; see the
 * session-projection subsystem page, docs/subsystems/session-projection.md):
 * the host is the only computation site; the client holds finished
 * whole values per key — `key → { value, seq, provenance }`. Session-list and
 * session-added blocks are tentative prewarm hints; a successful follow
 * opening installs the complete authoritative baseline, and Session Controller
 * `projection` frames advance authoritative rows by sequence. No client-side
 * domain folding exists: a domain ships projection support with zero client
 * code. Per-key bare observable faces feed `useProjection` (ui-renderer binds
 * them).
 */
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { Notifier } from './notifier.ts'

// The single projection type table, typed end to end (host unit, wire block,
// client store, React hook) — the Service Definition package's pure-type outlet
// (`/types`, zero imports), never the package root: the root's dsh-agent →
// dsh-session chain would drag the host `Context.sessions` merge into the
// client program (one program must not hold both sides). No second
// client-side "views" table (rejected in the Alternatives of
// .agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.md).
export type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'

/**
 * The fifth framework hook seat (see the session-projection subsystem page,
 * docs/subsystems/session-projection.md): key-addressed
 * projection reader delivered through the standard kit. `undefined` uniformly
 * means capability absent — host unit unmounted, or no baseline/frame has
 * carried the key yet. The selector overload mirrors useSession (per-key uSES
 * binding; reference stability holds because a key's value reference changes
 * only when a frame or baseline lands).
 */
export type UseProjection = {
  <K extends Extract<keyof SessionProjectionMap, string>>(key: K): SessionProjectionMap[K] | undefined
  <K extends Extract<keyof SessionProjectionMap, string>, S>(
    key: K,
    selector: (value: SessionProjectionMap[K] | undefined) => S,
    eq?: (a: S, b: S) => boolean,
  ): S
}

/**
 * Follow-opening projection baseline, restated here so the
 * React-free store depends only on the type table, not the wire package's
 * response vocabulary.
 */
export interface ProjectionsBaseline {
  /** The consistent-cut seq (equals the window tail seq by construction). */
  asOfSeq: number
  /** Whole current values by key; a registered key absent here means the capability is absent. */
  values: Readonly<Record<string, unknown>>
}

/** One key's row: the latest finished value, its cut, and its trust level. */
interface Row {
  value: unknown
  seq: number
  provenance: 'prewarm' | 'authoritative'
}

/** Per-key notification channel: the bare face plus its batching notifier. */
interface Channel {
  face: ObservableSnapshot<unknown>
  notifier: Notifier
}

/**
 * One session's projection values. A list hint can fill or advance only a
 * tentative row. A complete baseline replaces or clears every tentative row,
 * regardless of its claimed sequence, while preserving authoritative frames
 * newer than the baseline cut. The first authoritative frame replaces any
 * tentative hint; later authoritative frames use higher-sequence-wins. A key
 * the store has never seen reads `undefined` (capability absent). Faces are
 * identity-stable per key (create-on-demand, cached) so the React side binds
 * each exactly once; the store-level channel (`subscribeAny`) serves coarse
 * consumers (the manager's list projection reads the `title` key).
 */
export class ProjectionValueStore {
  private readonly rows = new Map<string, Row>()
  private readonly channels = new Map<string, Channel>()
  private valuesCache: Readonly<Partial<SessionProjectionMap>> | undefined
  /** Coarse any-key channel (no snapshot cache to rebuild: reads hit rows directly). */
  private readonly anyNotifier = new Notifier(() => {})

  /**
   * Key-addressed bare observable face (the useProjection resolution path).
   * Always defined — absence is an `undefined` snapshot, never a missing
   * face, so a component may subscribe before the key ever carries a value.
   * @param key - projection key.
   * @returns the identity-stable face for this key.
   */
  faceOf(key: string): ObservableSnapshot<unknown> {
    return this.channel(key).face
  }

  /**
   * Current whole value for a key (erased framework read; typed reads go
   * through `useProjection`'s map lookup).
   * @param key - projection key.
   * @returns the value, or undefined while the key is absent.
   */
  get(key: string): unknown {
    return this.rows.get(key)?.value
  }

  /**
   * Read every current projection value as one reference-stable snapshot.
   * @returns The same frozen value map until a row changes.
   */
  values(): Readonly<Partial<SessionProjectionMap>> {
    if (this.valuesCache === undefined) {
      this.valuesCache = Object.freeze(Object.fromEntries(
        [...this.rows].map(([key, row]) => [key, row.value]),
      ))
    }
    return this.valuesCache
  }

  /**
   * Subscribe to any-key changes (microtask-batched) — the manager's list
   * rebuild channel.
   * @param listener - change callback.
   * @returns the unsubscribe function.
   */
  subscribeAny(listener: () => void): () => void {
    return this.anyNotifier.subscribe(listener)
  }

  /**
   * Prewarm one tentative value from a partial Session list or session-added
   * block. Hints compete only with other hints; once an authoritative value is
   * known, no later list refresh may replace it.
   * @param key - projection key.
   * @param value - whole cached value.
   * @param seq - the cache row's claimed watermark.
   */
  prewarm(key: string, value: unknown, seq: number): void {
    const row = this.rows.get(key)
    if (row?.provenance === 'authoritative') return
    if (row !== undefined && seq <= row.seq) return
    this.rows.set(key, { value, seq, provenance: 'prewarm' })
    this.changed(key)
  }

  /**
   * Apply one finished value from the Session control stream.
   * @param key - projection key.
   * @param value - whole value computed by the host unit.
   * @param seq - the unit's watermark at emission.
   */
  apply(key: string, value: unknown, seq: number): void {
    const row = this.rows.get(key)
    if (row?.provenance === 'authoritative' && seq <= row.seq) return
    this.rows.set(key, { value, seq, provenance: 'authoritative' })
    this.changed(key)
  }

  /**
   * Seed from a complete history or control projections block. The baseline
   * replaces every tentative hint, including one whose cache watermark is
   * higher, and clears omitted hints. Only an authoritative frame newer than
   * the cut survives.
   * @param baseline - the response's projections block.
   */
  seed(baseline: ProjectionsBaseline): void {
    // Erased walk: the framework crosses the open key space; per-key typing
    // is re-established at the consumer (useProjection's map lookup).
    const values = baseline.values as Record<string, unknown>
    for (const key of Object.keys(values)) {
      const row = this.rows.get(key)
      if (row?.provenance === 'authoritative' && row.seq > baseline.asOfSeq) continue
      this.rows.set(key, { value: values[key], seq: baseline.asOfSeq, provenance: 'authoritative' })
      this.changed(key)
    }
    for (const [key, row] of this.rows) {
      if (Object.hasOwn(values, key)) continue
      if (row.provenance === 'authoritative' && row.seq > baseline.asOfSeq) continue
      this.rows.delete(key)
      this.changed(key)
    }
  }

  /**
   * Drop rows beyond a replacement control baseline. Such rows describe
   * process state the Host lost before persisting it and would otherwise
   * outrank recomputed lower-seq values forever. The caller seeds the new
   * baseline immediately afterward.
   * @param lastSeq - highest durable sequence reflected by the baseline.
   */
  truncate(lastSeq: number): void {
    for (const [key, row] of this.rows) {
      if (row.seq <= lastSeq) continue
      this.rows.delete(key)
      this.changed(key)
    }
  }

  private changed(key: string): void {
    this.valuesCache = undefined
    this.channels.get(key)?.notifier.markDirty()
    this.anyNotifier.markDirty()
  }

  private channel(key: string): Channel {
    let channel = this.channels.get(key)
    if (channel === undefined) {
      // The notifier only batches (no snapshot cache to rebuild: faces read rows directly).
      const notifier = new Notifier(() => {})
      channel = {
        notifier,
        face: {
          getSnapshot: () => this.rows.get(key)?.value,
          subscribe: listener => notifier.subscribe(listener),
        },
      }
      this.channels.set(key, channel)
    }
    return channel
  }
}
