/** Fetch-once cache of the change summaries the Host serves for announced `workspace/changes` events. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { changesSummaryUrl, isChangesSummary, type ChangesSummary } from '../changes.ts'

/** A summary, `'missing'` once the Host no longer serves it, or `'loading'` while the request runs. */
export type ChangesSummaryState = ChangesSummary | 'missing' | 'loading'

/** One browser plugin's summary reads, cleared on connection replacement and cancelled on disposal. */
export class ChangesSummaryStore {
  /** Summary URLs key the state across Sessions and turns. */
  readonly state = createSnapshotStore<Record<string, ChangesSummaryState | undefined>>({})
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<void>>()

  /**
   * Read one summary once; a later read of the same coordinates returns the cached state.
   * @param sessionId - viewed Session.
   * @param seq - the announcing event's sequence.
   * @returns after the state is published.
   */
  async load(sessionId: SessionId, seq: number): Promise<void> {
    const url = changesSummaryUrl(sessionId, seq)
    if (this.lifetime.signal.aborted || this.state.getSnapshot()[url] !== undefined) return
    this.state.update((state) => { state[url] = 'loading' })
    const task = this.read(url)
    this.pending.add(task)
    try {
      await task
    } finally {
      this.pending.delete(task)
    }
  }

  /** Forget every state; a replaced connection may reach a Host that no longer serves them. */
  reset(): void {
    this.state.set({})
  }

  /** Cancel outstanding reads and wait until none can publish state. */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    await Promise.all(this.pending)
  }

  private async read(url: string): Promise<void> {
    let next: ChangesSummaryState = 'missing'
    try {
      const response = await fetch(url, { signal: this.lifetime.signal })
      if (response.ok) {
        const value: unknown = await response.json()
        if (isChangesSummary(value)) next = value
      }
    } catch {
      // A transport failure reads as missing until the connection is replaced and the store reset.
      next = 'missing'
    }
    if (!this.lifetime.signal.aborted) this.state.update((state) => { state[url] = next })
  }
}
