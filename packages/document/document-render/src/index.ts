/** Host document rendering: authorized Office bytes become a complete PDF. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { DocumentRenderErrorCode, DocumentRenderRequest, DocumentRenderResult, DocumentRendererGeneration } from './types.ts'

export * from './types.ts'

/** Classified conversion failure; engine details stay in the cause. */
export class DocumentRenderError extends Error {
  /**
   * @param code - category suitable for a conversion consumer.
   * @param message - diagnostic explaining the failed conversion.
   * @param options - underlying engine or filesystem failure.
   */
  constructor(readonly code: DocumentRenderErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DocumentRenderError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** One Host renderer for already-authorized Office bytes. */
    documentRender: DocumentRenderer
  }
}

/** Load one provider subclass per context; consumers own source authorization. */
export abstract class DocumentRenderer extends Service {
  constructor(ctx: Context) { super(ctx, 'documentRender') }

  /** Changes whenever engine, font, or rendering configuration is replaced. */
  abstract readonly generation: DocumentRendererGeneration

  /**
   * Convert Office bytes without modifying the source or writing Session events.
   * @param request - authorized metadata and deferred bounded source read.
   * @param signal - caller cancellation; provider disposal also stops active work.
   * @returns caller-owned PDF bytes after conversion and scratch cleanup settle; canceled readers reject independently.
   * @throws {DocumentRenderError} Invalid input, unusable output, or engine failure; cancellation rejects with its reason.
   */
  abstract render(request: DocumentRenderRequest, signal?: AbortSignal): Promise<DocumentRenderResult>
}

export default DocumentRenderer
