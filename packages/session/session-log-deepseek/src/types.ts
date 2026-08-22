/** Wire types for lossless incremental DeepSeek session-log upload. */

import type { JsonValue, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'

/** Path from one DeepSeek wire message root to a string value. */
export type DeepSeekMessageStringPath = readonly (string | number)[]

/** Exact half-open UTF-8 slice of one string in the containing request's messages. */
export interface DeepSeekMessageStringSlice {
  readonly messageIndex: number
  readonly path: DeepSeekMessageStringPath
  readonly utf8Start: number
  readonly utf8End: number
}

/** One literal or request-relative fragment of a packed JSON string. */
export type PackedJsonStringPart =
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'message-slice'; readonly value: DeepSeekMessageStringSlice }

/** Tagged JSON representation whose string leaves may cite the containing request. */
export type PackedJsonValue =
  | { readonly kind: 'literal'; readonly value: JsonValue }
  | { readonly kind: 'string'; readonly parts: readonly PackedJsonStringPart[] }
  | { readonly kind: 'array'; readonly items: readonly PackedJsonValue[] }
  | { readonly kind: 'object'; readonly entries: readonly (readonly [string, PackedJsonValue])[] }

/** One canonical session event, sent raw unless request-relative references reduce its encoded bytes. */
export type EncodedSessionEvent =
  | { readonly encoding: 'raw'; readonly event: SessionEvent }
  | { readonly encoding: 'message-references'; readonly event: PackedJsonValue }

/** Versioned incremental session-log field carried by an official DeepSeek request. */
export interface DeepSeekSessionLogExtension {
  readonly version: 1
  readonly session: SessionHeader
  /** Highest sequence durably recorded as accepted before this request, or `-1`. */
  readonly afterSeq: number
  /** Highest sequence represented by {@link events}. */
  readonly throughSeq: number
  /** Contiguous canonical events from `afterSeq + 1` through `throughSeq`. */
  readonly events: readonly EncodedSessionEvent[]
}

declare module '@deepseek-ai/dsh-deepseek-llm-api-extensions/types' {
  interface DeepSeekLlmApiExtensionMap {
    dsh_session_log: DeepSeekSessionLogExtension
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Records that the configured endpoint accepted one delivery through `throughSeq`. */
    'session-log-deepseek/delivery-accepted': {
      /** Session identity the accepted delivery carried; inherited fork markers retain the parent's id. */
      sessionId: import('@deepseek-ai/dsh-session/types').SessionId
      /** Last canonical event included in the accepted request. */
      throughSeq: number
    }
  }
}
