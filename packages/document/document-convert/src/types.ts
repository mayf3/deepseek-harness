/** Authorized Office input and complete PDF output, independent of the conversion engine. */
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

/** Binary Office and Office Open XML formats supported by document preview. */
export type DocumentExtension = 'doc' | 'docx' | 'xls' | 'xlsx' | 'ppt' | 'pptx'

/** Authorized execution scope and canonical source path, encoded by the consumer. */
export type DocumentSourceKey = Branded<'DocumentSourceKey'>
/**
 * Label an authorized source locator for pre-read deduplication.
 * @param key - unambiguous encoding of authorization scope, execution world, and canonical path.
 * @returns branded source locator; source authorization remains the caller's responsibility.
 */
export function DocumentSourceKey(key: string): DocumentSourceKey { return brandString<DocumentSourceKey>(key) }

/** One provider lifetime, including its engine, rendering settings, and font configuration. */
export type DocumentConverterGeneration = Branded<'DocumentConverterGeneration'>
/**
 * Label a provider lifetime.
 * @param value - unique generation created by the provider.
 * @returns branded converter generation.
 */
export function DocumentConverterGeneration(value: string): DocumentConverterGeneration {
  return brandString<DocumentConverterGeneration>(value)
}

/** Provider generation and source-content digest; consumers must not parse it. */
export type DocumentConvertKey = Branded<'DocumentConvertKey'>
/**
 * Label a converter-owned content identity.
 * @param value - generation and content identity created by the provider.
 * @returns branded conversion identity.
 */
export function DocumentConvertKey(value: string): DocumentConvertKey { return brandString<DocumentConvertKey>(value) }

/** Foreground previews and explicit QA precede speculative background conversion. */
export type DocumentConvertPriority = 'foreground' | 'background'

/** Source authorization and metadata lookup must finish before submitting a request. */
export interface DocumentConvertRequest {
  readonly extension: DocumentExtension
  readonly priority: DocumentConvertPriority
  readonly source: {
    readonly key: DocumentSourceKey
    readonly version: string
    /** Authorized stat size; omission reserves the provider's entire input limit. */
    readonly bytes?: number
    /**
     * Read only after provider admission; do not capture already-buffered input in queued production requests.
     * @param signal - shared conversion lifetime, independent of an individual reader.
     * @param maxBytes - reserved source capacity; read at most this plus one overflow sentinel byte.
     * @returns owned bytes and the actual read version; a changed version rejects conversion.
     */
    read(signal: AbortSignal, maxBytes: number): Promise<{ readonly bytes: Uint8Array; readonly version: string }>
  }
}

/** Successful conversion; failed and interrupted conversions reject instead. */
export interface DocumentConvertResult {
  /** Caller-owned complete PDF, valid after provider disposal. */
  readonly pdf: Uint8Array
  /** Requested OOXML font families unavailable to this conversion; binary Office formats return an empty list. */
  readonly missingFonts: string[]
  readonly cacheKey: DocumentConvertKey
  readonly generation: DocumentConverterGeneration
}

/** Failures a conversion consumer can present without exposing engine diagnostics. */
export type DocumentConvertErrorCode =
  | 'input-too-large' | 'output-too-large' | 'invalid-document' | 'unsupported-format'
  | 'invalid-output' | 'timeout' | 'unavailable' | 'failed' | 'busy' | 'source-changed'
