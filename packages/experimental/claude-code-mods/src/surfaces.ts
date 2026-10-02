/**
 * The band above the prompt as the host draws it for one session: renders
 * through the mods' `ui.render` hooks, keeps the latest tree with its button
 * callbacks held host-side, redraws when a `$.state` value a render read
 * changes or a mod asks, and hands watchers each new generation.
 * @module
 */

import { serializeTree, treeProblem } from './elements.ts'
import type { UiNode } from './elements.ts'
import { messageOf } from './values.ts'
import type { SerializedNode, SurfaceSnapshot, UiRenderInput } from './types.ts'

export type { SurfaceSnapshot } from './types.ts'

/** The band's width the host reports to `ui.render` as `bodyColumns` and `viewport.columns`. */
export const BAND_COLUMNS = 120

/** What the table needs from the host. */
export interface SurfaceHost {
  /** Raise `ui.render` for one session through the mods and return the tree. */
  render(sessionId: string, input: UiRenderInput): Promise<UiNode>
  /** Run one button's callback inside the session; the host owns the invocation and its reporting. */
  runAction(sessionId: string, callback: () => unknown): Promise<void>
  /** Receives diagnostics: invalid trees, failed presses. */
  report(line: string): void
}

class SessionBand {
  generation = 0
  tree: readonly SerializedNode[] | null = null
  /** `$.state` slots the last render read, as `<plugin>\u0000<key>`. */
  readonly subscribed = new Set<string>()
  /** Button callbacks of the current generation, by the `actionId` the serialized tree carries. */
  readonly actions = new Map<string, () => unknown>()
  readonly watchers = new Set<(snapshot: SurfaceSnapshot) => void>()
  /** The render in flight, so concurrent refresh requests share one pass and a request during a pass runs once more after it. */
  rendering: Promise<void> | undefined
  again = false
  /** Set while a render runs: `$.state` reads subscribe. */
  collecting: Set<string> | undefined

  snapshot(): SurfaceSnapshot {
    return { generation: this.generation, tree: this.tree }
  }
}

/**
 * Bands by session id.
 */
export class SurfaceTable {
  private readonly bands = new Map<string, SessionBand>()
  private disposed = false

  constructor(private readonly host: SurfaceHost) {}

  /**
   * The latest snapshot of a session's band, drawing it first when nothing was drawn yet.
   * @param sessionId - the session.
   * @returns the current generation.
   */
  async current(sessionId: string): Promise<SurfaceSnapshot> {
    const band = this.bandOf(sessionId)
    if (band.generation === 0) await this.refresh(sessionId)
    return band.snapshot()
  }

  /**
   * Watch a session's band: the current snapshot first, then every redraw, until the signal aborts.
   * @param sessionId - the session.
   * @param signal - ends the watch.
   * @returns the snapshots.
   */
  async *watch(sessionId: string, signal: AbortSignal): AsyncIterable<SurfaceSnapshot> {
    const band = this.bandOf(sessionId)
    const queue: SurfaceSnapshot[] = []
    let wake: (() => void) | undefined
    const watcher = (snapshot: SurfaceSnapshot): void => {
      queue.push(snapshot)
      wake?.()
    }
    band.watchers.add(watcher)
    const onAbort = (): void => { wake?.() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const first = await this.current(sessionId)
      let delivered = first.generation
      yield first
      while (!signal.aborted) {
        const next = queue.shift()
        if (next !== undefined) {
          // The first drawing may arrive both as the current snapshot and as a watcher notification.
          if (next.generation <= delivered) continue
          delivered = next.generation
          yield next
          continue
        }
        await new Promise<void>((resolve) => { wake = resolve })
        wake = undefined
      }
    } finally {
      band.watchers.delete(watcher)
      signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Redraw a session's band through the mods and notify watchers when the tree changed.
   * @param sessionId - the session.
   * @returns settles once the redraw landed.
   */
  refresh(sessionId: string): Promise<void> {
    const band = this.bandOf(sessionId)
    if (band.rendering !== undefined) {
      band.again = true
      return band.rendering
    }
    band.rendering = this.renderOnce(sessionId, band).finally(() => {
      band.rendering = undefined
      if (band.again) {
        band.again = false
        void this.refresh(sessionId)
      }
    })
    return band.rendering
  }

  /**
   * Run the callback a button holds and redraw. A press from an earlier
   * generation is ignored: the button it names may no longer exist.
   * @param sessionId - the session.
   * @param generation - the generation the client saw.
   * @param actionId - the id the serialized Button carried.
   * @returns the snapshot after the press.
   */
  async press(sessionId: string, generation: number, actionId: string): Promise<SurfaceSnapshot> {
    const band = this.bandOf(sessionId)
    const action = generation === band.generation ? band.actions.get(actionId) : undefined
    if (action === undefined) {
      this.host.report(`band press ignored: ${actionId} of generation ${generation} is not on the current drawing (${band.generation})`)
      return band.snapshot()
    }
    await this.host.runAction(sessionId, action)
    await this.refresh(sessionId)
    return band.snapshot()
  }

  /**
   * Note a `$.state` read: during a render it subscribes the band to the slot.
   * @param sessionId - the session the state belongs to.
   * @param slot - the `<plugin>\u0000<key>` slot.
   */
  stateRead(sessionId: string, slot: string): void {
    this.bands.get(sessionId)?.collecting?.add(slot)
  }

  /**
   * Note a `$.state` write: a subscribed band redraws.
   * @param sessionId - the session the state belongs to.
   * @param slot - the `<plugin>\u0000<key>` slot.
   */
  stateWritten(sessionId: string, slot: string): void {
    const band = this.bands.get(sessionId)
    if (band === undefined || !band.subscribed.has(slot)) return
    void this.refresh(sessionId)
  }

  /**
   * Forget a session's band.
   * @param sessionId - the disposed session.
   */
  forget(sessionId: string): void {
    const band = this.bands.get(sessionId)
    if (band === undefined) return
    this.bands.delete(sessionId)
    band.watchers.clear()
  }

  /** Stop drawing: pending watchers end at their next wake. */
  dispose(): void {
    this.disposed = true
    for (const sessionId of [...this.bands.keys()]) this.forget(sessionId)
  }

  private bandOf(sessionId: string): SessionBand {
    let band = this.bands.get(sessionId)
    if (band === undefined) {
      band = new SessionBand()
      this.bands.set(sessionId, band)
    }
    return band
  }

  private async renderOnce(sessionId: string, band: SessionBand): Promise<void> {
    if (this.disposed) return
    const input: UiRenderInput = {
      component: 'AbovePrompt',
      surface: 'AbovePrompt',
      props: { bodyColumns: BAND_COLUMNS, hasSurvey: false, isWorking: false, maxRows: 10 },
      viewport: { columns: BAND_COLUMNS },
    }
    band.collecting = new Set()
    let tree: UiNode
    try {
      tree = await this.host.render(sessionId, input)
    } catch (error: unknown) {
      this.host.report(`band render failed: ${messageOf(error)}`)
      tree = null
    }
    band.subscribed.clear()
    for (const slot of band.collecting) band.subscribed.add(slot)
    band.collecting = undefined
    const problem = treeProblem(tree)
    if (problem !== undefined) {
      this.host.report(`a ui.render hook returned a tree that does not validate: ${problem}`)
      tree = null
    }
    // Action ids count up per drawing, so an unchanged tree serializes identically and keeps its generation.
    const actions = new Map<string, () => unknown>()
    const serialized = serializeTree(tree, (callback) => {
      const id = `a${actions.size}`
      actions.set(id, callback)
      return id
    })
    const next = serialized.length === 0 ? null : serialized
    if (band.generation > 0 && JSON.stringify(next) === JSON.stringify(band.tree)) {
      // The same drawing with possibly fresh closures: keep the generation, hold the new callbacks.
      band.actions.clear()
      for (const [id, action] of actions) band.actions.set(id, action)
      return
    }
    band.generation += 1
    band.tree = next
    band.actions.clear()
    for (const [id, action] of actions) band.actions.set(id, action)
    for (const watcher of band.watchers) watcher(band.snapshot())
  }
}
