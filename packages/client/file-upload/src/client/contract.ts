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

/**
 * Fetch-shaped carrier installed by a page that owns its Host transport.
 * @param input - absolute same-origin upload URL.
 * @param init - raw request body, headers, and cancellation signal.
 * @returns the Host response.
 */
export type FileUploadFetch = (input: URL, init: RequestInit) => Promise<Response>

/** Pre-Cordis hook supplied by a page whose Host runs in another execution context. */
export interface ClientFileUploadHooks {
  readonly fetch: FileUploadFetch
}
import type { Context } from '@deepseek-ai/cordis'
