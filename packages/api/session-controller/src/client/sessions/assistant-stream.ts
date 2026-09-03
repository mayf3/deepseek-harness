/** Web presentation fold joining durable v1 events with transient assistant frames. */

import type {
  SessionAssistantStreamBaseline,
  SessionAssistantStreamFrame,
} from '../../types.ts'
import type {
  SessionEventLikeEntry,
  SessionLiveEventEntry,
} from '../contract/events.ts'

interface ActiveAttempt {
  readonly turn: number
  readonly step: number
  readonly legacyChunkSeqs: Set<number>
  nextIndex: number
}

interface PendingAssistantMessage {
  readonly entry: SessionLiveEventEntry
  readonly sourceEventSeqs: readonly number[] | undefined
}

/** One Web publication decision from the assistant stream fold. */
export type ClientAssistantStreamResult =
  | { readonly type: 'publish'; readonly entry: SessionLiveEventEntry }
  | { readonly type: 'rebaseline' }
  | undefined

function positionKey(turn: number, step: number): string {
  return `${String(turn)}:${String(step)}`
}

function sameSeqs(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((seq, index) => seq === right[index])
}

/**
 * Keeps transient Assistant presentation behind one small interface. Durable
 * chunks and final messages publish only at their matching live frame.
 */
export class ClientAssistantStream {
  private readonly attempts = new Map<string, ActiveAttempt>()
  private readonly pendingChunks = new Map<number, SessionLiveEventEntry>()
  private readonly pendingMessages = new Map<string, PendingAssistantMessage>()
  private publishedSeqs = new Set<number>()

  /**
   * Replace the durable Web window and adopt an optional reconnect baseline.
   * @param entries - complete event window from the journal replacement.
   * @param baseline - active process-local attempts for a follow opening.
   * @returns the same durable window; baseline seqs suppress later duplicate live appends.
   */
  replace(
    entries: readonly SessionEventLikeEntry[],
    baseline?: SessionAssistantStreamBaseline,
  ): readonly SessionEventLikeEntry[] {
    this.pendingChunks.clear()
    this.pendingMessages.clear()
    this.attempts.clear()
    if (baseline !== undefined) {
      for (const attempt of baseline.attempts) {
        this.attempts.set(String(attempt.attemptId), {
          turn: attempt.turn,
          step: attempt.step,
          legacyChunkSeqs: new Set(attempt.legacyChunkSeqs),
          nextIndex: attempt.chunks.length,
        })
      }
    }
    const visible = entries
    this.publishedSeqs = new Set(visible.map(entry => entry.event.seq))
    return visible
  }

  /**
   * Stage one durable tail event when an active attempt owns its publication.
   * @param entry - next cursor-validated durable event.
   * @returns the entry for immediate publication, or undefined while staged.
   */
  acceptDurable(entry: SessionLiveEventEntry): ClientAssistantStreamResult {
    const event = entry.event
    if (event.type === 'assistant/chunk') {
      const attempt = this.attemptFor(event.data.turn, event.data.step)
      if (attempt === undefined) return this.publish(entry)
      if (attempt.legacyChunkSeqs.has(event.seq)) return this.publish(entry)
      if (this.pendingChunks.has(event.seq)) return { type: 'rebaseline' }
      this.pendingChunks.set(event.seq, entry)
      return undefined
    }
    if (event.type === 'assistant/message') {
      if (event.surfaceOp !== 'append') return this.publish(entry)
      const attempt = this.attemptFor(event.data.turn, event.data.step)
      if (attempt === undefined) return this.publish(entry)
      const key = positionKey(event.data.turn, event.data.step)
      if (this.pendingMessages.has(key)) return { type: 'rebaseline' }
      this.pendingMessages.set(key, { entry, sourceEventSeqs: event.sourceEventSeqs })
      return undefined
    }
    return this.publish(entry)
  }

  /**
   * Fold one validated transient frame and release its matching durable event.
   * @param frame - next dense process-local frame.
   * @returns one durable event whose Web publication commits at this frame.
   */
  acceptFrame(frame: SessionAssistantStreamFrame): ClientAssistantStreamResult {
    switch (frame.type) {
      case 'start':
        this.attempts.set(String(frame.attemptId), {
          turn: frame.turn,
          step: frame.step,
          legacyChunkSeqs: new Set(),
          nextIndex: 0,
        })
        return undefined
      case 'chunk': {
        const attempt = this.attempts.get(String(frame.attemptId))
        // A controller mounted after the Host saw this attempt has no start
        // frame to reconstruct. Its durable events already publish directly;
        // ignore the transient suffix until the next known attempt.
        if (attempt === undefined) return undefined
        if (frame.index !== attempt.nextIndex) return { type: 'rebaseline' }
        attempt.nextIndex += 1
        attempt.legacyChunkSeqs.add(frame.legacyChunkSeq)
        if (this.publishedSeqs.has(frame.legacyChunkSeq)) return undefined
        const entry = this.pendingChunks.get(frame.legacyChunkSeq)
        if (entry === undefined) return { type: 'rebaseline' }
        this.pendingChunks.delete(frame.legacyChunkSeq)
        return this.publish(entry)
      }
      case 'end': {
        const attempt = this.attempts.get(String(frame.attemptId))
        this.attempts.delete(String(frame.attemptId))
        if (attempt === undefined) return undefined
        if (frame.index !== attempt.nextIndex) return { type: 'rebaseline' }
        if (!sameSeqs([...attempt.legacyChunkSeqs], frame.legacyChunkSeqs)) {
          return { type: 'rebaseline' }
        }
        const key = positionKey(attempt.turn, attempt.step)
        const pending = this.pendingMessages.get(key)
        if (pending === undefined) {
          return frame.outcome === 'aborted' ? undefined : { type: 'rebaseline' }
        }
        const sourceEventSeqs = pending.sourceEventSeqs
        if (sourceEventSeqs === undefined || !sameSeqs(sourceEventSeqs, frame.legacyChunkSeqs)) {
          return { type: 'rebaseline' }
        }
        this.pendingMessages.delete(key)
        return this.publish(pending.entry)
      }
    }
  }

  private attemptFor(turn: number, step: number): ActiveAttempt | undefined {
    return [...this.attempts.values()].find(attempt => (
      attempt.turn === turn && attempt.step === step
    ))
  }

  private publish(entry: SessionLiveEventEntry): ClientAssistantStreamResult {
    this.publishedSeqs.add(entry.event.seq)
    return { type: 'publish', entry }
  }
}
