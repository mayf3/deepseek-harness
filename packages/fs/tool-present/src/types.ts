/** Durable file deliveries produced by the present tool. */
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment/types'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'

/** A saved file and the model-selected path it came from. */
export interface PresentedFile extends FileAttachmentRef {
  /** Original workspace path. */
  path: string
  /** Optional description supplied by the model. */
  description?: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Saved deliveries from a successful final present result, including nested calls. */
    'deliverables/presented': { turn: number; callId: ToolCallId; files: PresentedFile[] }
  }
}
