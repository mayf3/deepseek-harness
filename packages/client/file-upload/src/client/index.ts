/** Browser background-upload Cordis service. */

import type { Context } from '@deepseek-ai/cordis'
import { FileUploadRuntime } from './runtime.ts'

export type {
  ClientFileUploadHooks,
  FileUploadBody,
  FileUploadFetch,
  FileUploadProgress,
  FileUploadService,
} from './contract.ts'
export type { FileUploadReceiptId, FileUploadValue } from '../types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Agent-scoped browser service for staged file uploads. */
    fileUpload: import('./contract.ts').FileUploadService
  }
}

/** The upload service resolves Agent identity and the generated Remote fallback. */
export const inject = ['typert', 'remote']

/**
 * Provide the browser background-upload service.
 * @param ctx - Client plugin context.
 */
export function apply(ctx: Context): void {
  ctx.plugin(FileUploadRuntime)
}
