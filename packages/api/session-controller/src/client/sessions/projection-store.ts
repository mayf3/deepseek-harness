/**
 * Generic per-session projection value store (push model; see the
 * session-projection subsystem page, docs/subsystems/session-projection.md):
 * the host is the only computation site; the client holds finished
 * whole values per key. The store distinguishes tentative list hints from
 * authoritative frames and complete baselines, and owns their precedence
 * across opening and reconnect lifecycles. No client-side domain folding
 * exists: a domain ships projection support with zero client code. Per-key
 * bare observable faces feed `useProjection` (ui-renderer binds them).
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

/** Opaque marker for one exact Session opening lifecycle. */
export interface ProjectionOpeningToken {
  /** Store revision when the opening began. */
  readonly revision: number
}

/** One key's row with its authority and arrival revision. */
interface Row {
  value: unknown
  seq: number
  provenance: 'tentative' | 'authoritative'
  revision: number
}

/** Per-key notification channel: the bare face plus its batching notifier. */
interface Channel {
  face: ObservableSnapshot<unknown>
  notifier: Notifier
}

/**
 * One session's projection values. Framework semantics are uniform across
 * source: list hints are tentative, frames are authoritative per-key updates,
 * and opening/control baselines are complete authoritative cuts. A key the
 * store has never seen reads `undefined` (capability absent). Faces are
 * identity-stable per key (create-on-demand, cached) so the React side binds
 * each exactly once; the store-level channel (`subscribeAny`) serves coarse
 * consumers.
 */
export class ProjectionValueStore {
  private readonly rows = new Map<string, Row>()
  private readonly channels = new Map<string, Channel>()
  private valuesCache: Readonly<Partial<SessionProjectionMap>> | undefined
  private revision = 0
  private activeOpening: ProjectionOpeningToken | undefined
  private latestControlBaseline: { readonly revision: number; readonly asOfSeq: number } | undefined
  private completeBaselineInstalled = false
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
   * Apply the latest partial cache-backed hint while no complete authoritative
   * cut exists. Arrival order, not the cached watermark, orders tentative rows:
   * crash repair may legitimately lower the durable sequence.
   * @param hint - partial projection values from the Session list cache.
   */
  prewarm(hint: ProjectionsBaseline): void {
    if (this.completeBaselineInstalled) return
    const values = hint.values as Record<string, unknown>
    for (const key of Object.keys(values)) {
      const previous = this.rows.get(key)
      if (previous?.provenance === 'authoritative') continue
      this.installRow(key, {
        value: values[key],
        seq: hint.asOfSeq,
        provenance: 'tentative',
        revision: ++this.revision,
      })
    }
  }

  /**
   * Apply one authoritative finished value from the Session control stream.
   * The first frame replaces a tentative row regardless of sequence; later
   * authoritative frames use strict higher-sequence ordering.
   * @param key - projection key.
   * @param value - whole value computed by the host unit.
   * @param seq - the unit's watermark at emission.
   */
  apply(key: string, value: unknown, seq: number): void {
    const row = this.rows.get(key)
    if (row?.provenance === 'authoritative' && seq <= row.seq) return
    this.rows.set(key, {
      value,
      seq,
      provenance: 'authoritative',
      revision: ++this.revision,
    })
    this.changed(key)
  }

  /**
   * Start one exact opening. The token lets completion distinguish state that
   * existed before the request from authoritative frames arriving afterward.
   * @returns an opaque token owned by the caller's opening lifecycle.
   */
  beginOpening(): ProjectionOpeningToken {
    const token = Object.freeze({ revision: this.revision })
    this.activeOpening = token
    return token
  }

  /**
   * Complete an exact opening. A control baseline received after the token
   * wins at an equal or newer cut. Otherwise the opening replaces all prior
   * state and retains only authoritative post-token frames newer than its cut.
   * @param token - token returned by {@link beginOpening}.
   * @param baseline - complete projection values at the opening cut.
   */
  completeOpening(token: ProjectionOpeningToken, baseline: ProjectionsBaseline): void {
    if (this.activeOpening !== token) return
    this.activeOpening = undefined
    const control = this.latestControlBaseline
    if (control !== undefined
      && control.revision > token.revision
      && control.asOfSeq >= baseline.asOfSeq) {
      return
    }

    const retained = [...this.rows].filter(([, row]) =>
      row.provenance === 'authoritative'
      && row.revision > token.revision
      && row.seq > baseline.asOfSeq)
    this.completeBaselineInstalled = true
    this.replaceRows(baseline, ++this.revision, 'authoritative')
    for (const [key, row] of retained) this.installRow(key, row)
  }

  /**
   * End one failed or superseded opening without changing the already visible
   * values. Later openings receive a fresh revision boundary.
   * @param token - token returned by {@link beginOpening}.
   */
  cancelOpening(token: ProjectionOpeningToken): void {
    if (this.activeOpening === token) this.activeOpening = undefined
  }

  /**
   * Replace the previous control-stream generation exactly, including rows at
   * the same sequence. Frames arriving afterward again use higher-seq-wins.
   * @param baseline - complete projections for the new control generation.
   */
  replaceControlBaseline(baseline: ProjectionsBaseline): void {
    const revision = ++this.revision
    this.completeBaselineInstalled = true
    this.latestControlBaseline = { revision, asOfSeq: baseline.asOfSeq }
    this.replaceRows(baseline, revision, 'authoritative')
  }

  /**
   * Replace state for a Session omitted from a new control generation. The
   * Host cut invalidates prior authoritative rows, while the latest retained
   * list block may immediately repopulate tentative sidebar values.
   * @param hint - latest partial list-cache block retained for the Session.
   */
  replaceControlOmission(hint?: ProjectionsBaseline): void {
    const revision = ++this.revision
    this.completeBaselineInstalled = false
    this.latestControlBaseline = undefined
    if (hint === undefined) {
      for (const key of this.rows.keys()) {
        this.rows.delete(key)
        this.changed(key)
      }
      return
    }
    this.replaceRows(hint, revision, 'tentative')
  }

  private changed(key: string): void {
    this.valuesCache = undefined
    this.channels.get(key)?.notifier.markDirty()
    this.anyNotifier.markDirty()
  }

  /** Replace every row with one baseline at the supplied authority. */
  private replaceRows(
    baseline: ProjectionsBaseline,
    revision: number,
    provenance: Row['provenance'],
  ): void {
    const values = baseline.values as Record<string, unknown>
    const keys = new Set([...this.rows.keys(), ...Object.keys(values)])
    for (const key of keys) {
      if (!Object.hasOwn(values, key)) {
        this.rows.delete(key)
        this.changed(key)
        continue
      }
      this.installRow(key, {
        value: values[key],
        seq: baseline.asOfSeq,
        provenance,
        revision,
      })
    }
  }

  /** Install one row while notifying only when its observable value changes. */
  private installRow(key: string, row: Row): void {
    const previous = this.rows.get(key)
    this.rows.set(key, row)
    if (previous === undefined || !Object.is(previous.value, row.value)) this.changed(key)
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
