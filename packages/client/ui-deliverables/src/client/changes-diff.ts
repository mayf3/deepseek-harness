/** Cache of the file comparisons the Host serves for listed changed files, read once per comparison and again on request. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { changesDiffUrl, isChangesDiff, type ChangesDiff } from '../changes.ts'

/**
 * A comparison, `'missing'` once the Host no longer serves it, `'error'` for
 * a failed read a later request retries, or `'loading'` while the request runs.
 */
export type ChangesDiffState = ChangesDiff | 'missing' | 'error' | 'loading'

/** One browser plugin's comparison reads, cleared on connection replacement and cancelled on disposal. */
export class ChangesDiffStore {
  /** Comparison URLs key the state across Sessions, turns, and files. */
  readonly state = createSnapshotStore<Record<string, ChangesDiffState | undefined>>({})
  private readonly lifetime = new AbortController()
  /** The connection generation the current states belong to; a reset aborts it so no older read publishes. */
  private generation = new AbortController()
  private readonly pending = new Set<Promise<void>>()

  /**
   * Read one comparison; a cached comparison or a missing one is kept, a failed one is read again.
   * @param sessionId - viewed Session.
   * @param seq - the announcing event's sequence.
   * @param index - the file's index in the summary.
   * @returns after the state is published.
   */
  async load(sessionId: SessionId, seq: number, index: number): Promise<void> {
    const url = changesDiffUrl(sessionId, seq, index)
    const current = this.state.getSnapshot()[url]
    if (this.lifetime.signal.aborted || (current !== undefined && current !== 'error')) return
    this.state.update((state) => { state[url] = 'loading' })
    const task = this.read(url, AbortSignal.any([this.lifetime.signal, this.generation.signal]))
    this.pending.add(task)
    try {
      await task
    } finally {
      this.pending.delete(task)
    }
  }

  /** Forget every state and abandon in-flight reads; a replaced connection may reach a Host that no longer serves them. */
  reset(): void {
    this.generation.abort()
    this.generation = new AbortController()
    this.state.set({})
  }

  /** Cancel outstanding reads and wait until none can publish state. */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    await Promise.all(this.pending)
  }

  private async read(url: string, signal: AbortSignal): Promise<void> {
    let next: ChangesDiffState = 'error'
    try {
      const response = await fetch(url, { signal })
      if (response.status === 404) next = 'missing'
      else if (response.ok) {
        const value: unknown = await response.json()
        if (isChangesDiff(value)) next = value
      }
    } catch {
      // A transport failure stays retryable until the connection is replaced and the store reset.
      next = 'error'
    }
    if (!signal.aborted) this.state.update((state) => { state[url] = next })
  }
}
