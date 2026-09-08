/** Durable file deliveries produced by the present tool. */
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'

/** A declared workspace file whose current contents remain at its source path. */
export interface PresentedFile {
  /** Original workspace path. */
  path: string
  /** Optional description supplied by the model. */
  description?: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Declared workspace files from a successful final present result, including nested calls. */
    'deliverables/presented': { turn: number; callId: ToolCallId; files: PresentedFile[] }
  }
}
