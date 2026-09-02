/** Process-local assistant attempt framing for live consumers. */

import { LlmAttemptId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'

/** Folds one model attempt into ordered transient frames. */
export class AssistantStreamAttempt {
  private readonly legacyChunkSeqs: SessionSeq[] = []
  private index = 0
  private terminal = false
  /** Process-local attempt identity. */
  readonly attemptId: LlmAttemptId

  /** Whether this started attempt has emitted its terminal frame. */
  get ended(): boolean { return this.terminal }

  /**
   * @param sessionId - identity embedded only in the process-local attempt id.
   * @param attempt - attached-Session-local attempt counter.
   * @param nextRevision - allocates the next emitted frame revision.
   * @param turn - durable turn owning the request.
   * @param step - durable step owning the request.
   * @param emit - agent-scoped notification publisher.
   */
  constructor(
    sessionId: SessionId,
    attempt: number,
    private readonly nextRevision: () => number,
    readonly turn: number,
    readonly step: number,
    private readonly emit: (frame: AssistantStreamFrame) => void,
  ) {
    this.attemptId = LlmAttemptId(`${sessionId}:${attempt}`)
  }

  /** Publish the opening marker before the first delivered chunk. */
  start(): void {
    this.emit({
      type: 'start',
      attemptId: this.attemptId,
      revision: this.nextRevision(),
      startedTime: Date.now(),
      turn: this.turn,
      step: this.step,
    })
  }

  /** Publish one chunk only after its durable v1 record has appended. */
  push(chunk: StreamChunk, legacyChunkSeq: SessionSeq): void {
    this.legacyChunkSeqs.push(legacyChunkSeq)
    this.emit({
      type: 'chunk',
      attemptId: this.attemptId,
      revision: this.nextRevision(),
      index: this.index++,
      chunk,
      legacyChunkSeq,
    })
  }

  /** Publish terminal settlement; `committed` follows its durable assistant message. */
  end(outcome: 'committed' | 'aborted'): void {
    this.terminal = true
    this.emit({
      type: 'end',
      attemptId: this.attemptId,
      revision: this.nextRevision(),
      index: this.index,
      outcome,
      legacyChunkSeqs: [...this.legacyChunkSeqs],
    })
  }
}
