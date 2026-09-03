/** Process-local assistant state retained for reconnecting Web followers. */

import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {
  SessionAssistantStreamAttempt,
  SessionAssistantStreamBaseline,
} from './types.ts'

type ChunkFrame = Extract<AssistantStreamFrame, { type: 'chunk' }>

interface MutableAttempt {
  readonly attemptId: SessionAssistantStreamAttempt['attemptId']
  readonly turn: number
  readonly step: number
  readonly chunks: ChunkFrame[]
  readonly legacyChunkSeqs: number[]
}

const EMPTY_BASELINE: SessionAssistantStreamBaseline = { revision: 0, attempts: [] }

/**
 * Folds dense Agent frames and materializes one shared immutable reconnect
 * baseline per accepted revision.
 */
export class SessionAssistantStreamAccumulator {
  private readonly attempts = new Map<string, MutableAttempt>()
  private revision = 0
  private snapshotValue: SessionAssistantStreamBaseline = EMPTY_BASELINE
  private dirty = false

  /**
   * Fold one trusted frame from the current attached Agent lifecycle.
   * @param frame - next dense process-local Assistant frame.
   */
  accept(frame: AssistantStreamFrame): void {
    if (frame.type === 'start' && frame.revision === 1 && this.revision !== 0) {
      this.attempts.clear()
      this.revision = 0
    }
    if (frame.revision !== this.revision + 1) {
      this.attempts.clear()
      this.revision = frame.revision
      this.dirty = true
      return
    }
    this.revision = frame.revision
    switch (frame.type) {
      case 'start':
        this.attempts.set(String(frame.attemptId), {
          attemptId: frame.attemptId,
          turn: frame.turn,
          step: frame.step,
          chunks: [],
          legacyChunkSeqs: [],
        })
        break
      case 'chunk': {
        const attempt = this.attempts.get(String(frame.attemptId))
        if (attempt === undefined || frame.index !== attempt.chunks.length) {
          this.attempts.clear()
          break
        }
        attempt.chunks.push(frame)
        attempt.legacyChunkSeqs.push(frame.legacyChunkSeq)
        break
      }
      case 'end':
        this.attempts.delete(String(frame.attemptId))
        break
    }
    this.dirty = true
  }

  /**
   * Read the cached reconnect baseline, materializing it after a state change.
   * @returns the identity-stable baseline for the latest accepted revision.
   */
  snapshot(): SessionAssistantStreamBaseline {
    if (!this.dirty) return this.snapshotValue
    this.snapshotValue = {
      revision: this.revision,
      attempts: [...this.attempts.values()].map(attempt => ({
        attemptId: attempt.attemptId,
        turn: attempt.turn,
        step: attempt.step,
        chunks: attempt.chunks.map(frame => frame.chunk as JsonValue),
        legacyChunkSeqs: [...attempt.legacyChunkSeqs],
      })),
    }
    this.dirty = false
    return this.snapshotValue
  }
}
