import type { Context } from '@deepseek-ai/cordis'

/** Browser request body accepted by the background file-upload service. */
export type FileUploadBody = Blob | ReadableStream<Uint8Array>

/** Monotone byte progress reported while a browser body is consumed. */
export interface FileUploadProgress {
  readonly loaded: number
  readonly total?: number
}

/** Browser upload service addressed through one Client Agent scope. */
export interface FileUploadService {
  /** Whether this page has a Host-backed background upload carrier. */
  readonly available: boolean
  /**
   * Store one file under an Agent scope. Blob and stream bodies use
   * the background carrier; exact bytes and fixture fallbacks use Remote.
   * @param owner - Agent-scoped Client context that owns the staged receipt.
   * @param data - browser Blob, exact bytes, or a one-shot byte stream.
   * @param name - optional display name.
   * @param signal - optional cancellation for the active upload.
   * @param onProgress - optional byte-progress observer for background bodies.
   * @returns the staged receipt and durable file reference, or a business error.
   */
  upload(
    owner: Context,
    data: Blob | Uint8Array | ReadableStream<Uint8Array>,
    name?: string,
    signal?: AbortSignal,
    onProgress?: (progress: FileUploadProgress) => void,
  ): Promise<import('@deepseek-ai/dsh-typert-protocol').RemoteResult<
    import('../types.ts').FileUploadValue
  >>
}

export type { ClientFileUploadHooks, FileUploadFetch } from '../types.ts'
