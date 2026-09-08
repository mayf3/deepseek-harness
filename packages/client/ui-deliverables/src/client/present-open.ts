/** Shared native-open status for delivery cards and closing-message file mentions. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { presentedFileUrl } from '../presented.ts'

/** State of the latest explicit open gesture for one saved file. */
export type PresentedOpenPhase = 'opening' | 'opened' | 'error'

/** One browser plugin's file-open requests, cancelled when that plugin is disposed. */
export class PresentedOpenController {
  /** File action URLs key the state across Sessions, turns, and both clickable surfaces. */
  readonly state = createSnapshotStore<Record<string, PresentedOpenPhase | undefined>>({})
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<void>>()

  /**
   * Open a declared workspace file once while a request for the same coordinates is pending.
   * Failures remain visible on the card and a later gesture retries them.
   * @param sessionId - viewed Session, including a fork's own identity.
   * @param seq - durable delivery event sequence.
   * @param index - original file index within that event.
   * @returns after the Host acknowledges opening or the error state is published.
   */
  async open(sessionId: SessionId, seq: number, index: number): Promise<void> {
    const url = presentedFileUrl(sessionId, seq, index)
    if (this.lifetime.signal.aborted || this.state.getSnapshot()[url] === 'opening') return
    this.state.update((state) => { state[url] = 'opening' })
    const task = this.request(url)
    this.pending.add(task)
    try {
      await task
    } finally {
      this.pending.delete(task)
    }
  }

  /** Cancel outstanding requests and wait until no request can publish state. */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    await Promise.all(this.pending)
  }

  private async request(url: string): Promise<void> {
    let phase: PresentedOpenPhase = 'opened'
    try {
      const response = await fetch(url, { method: 'POST', signal: this.lifetime.signal })
      if (!response.ok) phase = 'error'
    } catch {
      // Transport failures share the retryable card state with Host open failures.
      phase = 'error'
    }
    if (!this.lifetime.signal.aborted) this.state.update((state) => { state[url] = phase })
  }
}
