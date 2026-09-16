/** Host document conversion: authorized Office bytes become a complete PDF. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { DocumentConvertErrorCode, DocumentConvertRequest, DocumentConvertResult, DocumentConverterGeneration } from './types.ts'

export * from './types.ts'

/** Classified conversion failure; engine details stay in the cause. */
export class DocumentConvertError extends Error {
  /**
   * @param code - category suitable for a conversion consumer.
   * @param message - diagnostic explaining the failed conversion.
   * @param options - underlying engine or filesystem failure.
   */
  constructor(readonly code: DocumentConvertErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DocumentConvertError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** One Host converter for already-authorized Office bytes. */
    documentConvert: DocumentConverter
  }
}

/** Load one provider subclass per context; consumers own source authorization. */
export abstract class DocumentConverter extends Service {
  constructor(ctx: Context) { super(ctx, 'documentConvert') }

  /** Changes whenever engine, font, or conversion configuration is replaced. */
  abstract readonly generation: DocumentConverterGeneration

  /**
   * Convert Office bytes without modifying the source or writing Session events.
   * @param request - authorized metadata and deferred bounded source read.
   * @param signal - caller cancellation; provider disposal also stops active work.
   * @returns caller-owned PDF bytes after conversion and scratch cleanup settle; canceled readers reject independently.
   * @throws {DocumentConvertError} Invalid input, unusable output, or engine failure; cancellation rejects with its reason.
   */
  abstract convert(request: DocumentConvertRequest, signal?: AbortSignal): Promise<DocumentConvertResult>
}

export default DocumentConverter
