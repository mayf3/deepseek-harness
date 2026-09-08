/**
 * The observer plumbing the card forms share: subscribe, publish, and the
 * snapshot-store projection slot components read through.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** A form whose reads change underneath its observers, which it tells after each change. */
export abstract class ObservableForm {
  private readonly listeners = new Set<() => void>()

  /**
   * Observe the form: every change it publishes.
   * @param listener - invoked after each change.
   * @returns the disposer removing this listener.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Publish a projection of this form, rebuilt after every change it publishes.
   * @param project - build the card's state from the form's current reads.
   * @returns the store the card's component reads through its bound selector.
   */
  bind<S>(project: () => S): SnapshotStore<S> {
    const store = createSnapshotStore(project())
    this.subscribe(() => { store.set(project()) })
    return store
  }

  /** Tell every observer that a read changed. */
  protected publish(): void {
    for (const listener of this.listeners) listener()
  }
}
