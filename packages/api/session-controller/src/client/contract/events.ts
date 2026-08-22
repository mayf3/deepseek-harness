/** Observable contiguous Session event window consumed by domain assemblers. */
import { notifySubscribers, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionEventEntry } from '../../types.ts'

/** Exact delta that produced the latest event-window revision. */
export type SessionEventChange =
  | { readonly kind: 'replace'; readonly entries: readonly SessionEventEntry[] }
  | { readonly kind: 'prepend'; readonly entries: readonly SessionEventEntry[] }
  | { readonly kind: 'append'; readonly entries: readonly SessionEventEntry[] }

/** Current contiguous event window and its latest synchronous delta. */
export interface SessionEventWindow {
  readonly entries: readonly SessionEventEntry[]
  readonly hasMore: boolean
  readonly revision: number
  readonly change: SessionEventChange
}

/** Conversation-facing event source exposed by one Session binding. */
export type SessionEventSource = ObservableSnapshot<SessionEventWindow>

/** Session-owned event feed; every accepted window mutation publishes synchronously. */
export class MutableSessionEventSource implements SessionEventSource {
  private readonly listeners = new Set<() => void>()
  private snapshot: SessionEventWindow = {
    entries: [],
    hasMore: false,
    revision: 0,
    change: { kind: 'replace', entries: [] },
  }

  /** @returns the cached event-window snapshot. */
  getSnapshot(): SessionEventWindow { return this.snapshot }

  /**
   * Subscribe to synchronous window publication.
   * @param listener - invalidation callback.
   * @returns unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Replace the complete contiguous window.
   * @param entries - complete window.
   * @param hasMore - whether older history remains.
   */
  replace(entries: readonly SessionEventEntry[], hasMore: boolean): void {
    this.publish(entries, hasMore, { kind: 'replace', entries })
  }

  /**
   * Prepend one older contiguous page.
   * @param entries - newly loaded older entries.
   * @param hasMore - whether still older history remains.
   */
  prepend(entries: readonly SessionEventEntry[], hasMore: boolean): void {
    this.publish([...entries, ...this.snapshot.entries], hasMore, { kind: 'prepend', entries })
  }

  /**
   * Append one contiguous live entry.
   * @param entry - live tail entry.
   */
  append(entry: SessionEventEntry): void {
    this.publish([...this.snapshot.entries, entry], this.snapshot.hasMore, {
      kind: 'append',
      entries: [entry],
    })
  }

  private publish(
    entries: readonly SessionEventEntry[],
    hasMore: boolean,
    change: SessionEventChange,
  ): void {
    this.snapshot = { entries, hasMore, revision: this.snapshot.revision + 1, change }
    notifySubscribers(this.listeners, '[session-controller] event feed')
  }
}
