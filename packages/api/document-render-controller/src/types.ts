/** Browser-safe complete PDF bytes with source identity and font notices. */
import type { WorkspaceFileBytes } from '@deepseek-ai/dsh-api-workspace-files/types'
import type { OfficeToPdfErrorCode, OfficeToPdfGeneration } from '@deepseek-ai/dsh-office-to-pdf/types'
import type {} from '@deepseek-ai/dsh-typert-protocol'

/** PDF content carries the original Office file's absolute path and version. */
export interface RenderedDocumentBytes extends WorkspaceFileBytes {
  readonly missingFonts: string[]
  readonly generation: OfficeToPdfGeneration
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The source was authorized, but its conversion failed. */
    'document-render/failed': { readonly reason: OfficeToPdfErrorCode }
  }
}
