/** Lossless request-relative packing for canonical session events. */

import { Buffer } from 'node:buffer'
import type { DeepSeekLlmApiJson } from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import type { JsonValue, SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  DeepSeekMessageStringSlice,
  EncodedSessionEvent,
  PackedJsonStringPart,
  PackedJsonValue,
} from './types.ts'

interface MessageStringSource {
  readonly messageIndex: number
  readonly path: readonly (string | number)[]
  readonly value: string
  readonly bytes: number
}

interface PackedCandidate {
  readonly value: PackedJsonValue
  readonly references: boolean
}

/** Return the serialized UTF-8 size used by the profitability decision. */
function wireBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/** Enumerate every string leaf of the exact wire messages. */
function collectSources(
  value: DeepSeekLlmApiJson,
  messageIndex: number,
  path: readonly (string | number)[],
  output: MessageStringSource[],
): void {
  if (typeof value === 'string') {
    if (value.length > 0) output.push({ messageIndex, path, value, bytes: Buffer.byteLength(value, 'utf8') })
    return
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => { collectSources(child, messageIndex, [...path, index], output) })
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) collectSources(child, messageIndex, [...path, key], output)
}

/** Build one exact slice from UTF-16 offsets, or reject a lossy UTF-8 conversion. */
function sliceOf(source: MessageStringSource, start: number, end: number): DeepSeekMessageStringSlice | undefined {
  const candidate: DeepSeekMessageStringSlice = {
    messageIndex: source.messageIndex,
    path: source.path,
    utf8Start: Buffer.byteLength(source.value.slice(0, start), 'utf8'),
    utf8End: Buffer.byteLength(source.value.slice(0, end), 'utf8'),
  }
  const bytes = Buffer.from(source.value, 'utf8')
  const selected = bytes.subarray(candidate.utf8Start, candidate.utf8End)
  const decoded = selected.toString('utf8')
  return decoded === source.value.slice(start, end) && Buffer.from(decoded, 'utf8').equals(selected)
    ? candidate
    : undefined
}

/** Find a profitable exact whole-string or one-inner-string reference. */
function packString(value: string, sources: readonly MessageStringSource[]): PackedCandidate {
  const literal: PackedJsonValue = { kind: 'literal', value }
  if (value.length === 0) return { value: literal, references: false }
  const valueBytes = Buffer.byteLength(value, 'utf8')

  let best: PackedJsonValue | undefined
  let bestBytes = wireBytes(literal)
  for (const source of sources) {
    if (source.bytes < valueBytes) continue
    const start = source.value.indexOf(value)
    if (start < 0) continue
    const slice = sliceOf(source, start, start + value.length)
    if (slice === undefined) continue
    const candidate: PackedJsonValue = {
      kind: 'string',
      parts: [{ kind: 'message-slice', value: slice }],
    }
    const bytes = wireBytes(candidate)
    if (bytes < bestBytes) {
      best = candidate
      bestBytes = bytes
    }
  }
  if (best !== undefined) return { value: best, references: true }

  for (const source of sources) {
    if (source.bytes > valueBytes) continue
    const start = value.indexOf(source.value)
    if (start < 0) continue
    const slice = sliceOf(source, 0, source.value.length)
    if (slice === undefined) continue
    const parts: PackedJsonStringPart[] = []
    if (start > 0) parts.push({ kind: 'literal', value: value.slice(0, start) })
    parts.push({ kind: 'message-slice', value: slice })
    const end = start + source.value.length
    if (end < value.length) parts.push({ kind: 'literal', value: value.slice(end) })
    const candidate: PackedJsonValue = { kind: 'string', parts }
    const bytes = wireBytes(candidate)
    if (bytes < bestBytes) {
      best = candidate
      bestBytes = bytes
    }
  }
  return best === undefined
    ? { value: literal, references: false }
    : { value: best, references: true }
}

/** Recursively pack one JSON value, retaining references only when the complete subtree shrinks. */
function packValue(value: JsonValue, sources: readonly MessageStringSource[]): PackedCandidate {
  const literal: PackedJsonValue = { kind: 'literal', value }
  if (typeof value === 'string') return packString(value, sources)
  if (value === null || typeof value !== 'object') return { value: literal, references: false }

  if (Array.isArray(value)) {
    const children = value.map(child => packValue(child, sources))
    if (!children.some(child => child.references)) return { value: literal, references: false }
    const candidate: PackedJsonValue = { kind: 'array', items: children.map(child => child.value) }
    return { value: candidate, references: true }
  }

  const children = Object.entries(value).map(([key, child]) => [key, packValue(child, sources)] as const)
  if (!children.some(([, child]) => child.references)) return { value: literal, references: false }
  const candidate: PackedJsonValue = {
    kind: 'object',
    entries: children.map(([key, child]) => [key, child.value]),
  }
  return { value: candidate, references: true }
}

/** Resolve one path in a parsed wire message. */
function valueAt(root: DeepSeekLlmApiJson, path: readonly (string | number)[]): DeepSeekLlmApiJson {
  let value = root
  for (const segment of path) {
    if (typeof segment === 'number') {
      if (!Array.isArray(value) || segment < 0 || segment >= value.length) {
        throw new Error(`session-log-deepseek: message reference has invalid array segment ${segment}`)
      }
      value = value[segment] as DeepSeekLlmApiJson
      continue
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, segment)) {
      throw new Error(`session-log-deepseek: message reference has invalid object segment ${JSON.stringify(segment)}`)
    }
    value = value[segment] as DeepSeekLlmApiJson
  }
  return value
}

/** Decode and validate one exact UTF-8 message slice. */
function decodeSlice(messages: readonly DeepSeekLlmApiJson[], slice: DeepSeekMessageStringSlice): string {
  const message = messages[slice.messageIndex]
  if (message === undefined) throw new Error(`session-log-deepseek: message reference index ${slice.messageIndex} is absent`)
  const source = valueAt(message, slice.path)
  if (typeof source !== 'string') throw new Error('session-log-deepseek: message reference path does not resolve to a string')
  const bytes = Buffer.from(source, 'utf8')
  if (!Number.isSafeInteger(slice.utf8Start) || !Number.isSafeInteger(slice.utf8End)
    || slice.utf8Start < 0 || slice.utf8End <= slice.utf8Start || slice.utf8End > bytes.length) {
    throw new Error('session-log-deepseek: message reference byte range is invalid')
  }
  const selected = bytes.subarray(slice.utf8Start, slice.utf8End)
  const decoded = selected.toString('utf8')
  if (!Buffer.from(decoded, 'utf8').equals(selected)) {
    throw new Error('session-log-deepseek: message reference splits a UTF-8 code point')
  }
  return decoded
}

/**
 * Decode one packed JSON value against the containing request's messages.
 * @param value - tagged literal/reference value to reconstruct.
 * @param messages - serialized messages from the same request.
 * @returns the exact reconstructed JSON value.
 */
export function unpackJsonValue(value: PackedJsonValue, messages: readonly DeepSeekLlmApiJson[]): JsonValue {
  switch (value.kind) {
    case 'literal':
      return structuredClone(value.value)
    case 'string':
      return value.parts.map(part => part.kind === 'literal' ? part.value : decodeSlice(messages, part.value)).join('')
    case 'array':
      return value.items.map(item => unpackJsonValue(item, messages))
    case 'object':
      return Object.fromEntries(value.entries.map(([key, child]) => [key, unpackJsonValue(child, messages)]))
    default:
      throw new Error('session-log-deepseek: unknown packed JSON value')
  }
}

/**
 * Encode canonical session events against the exact DeepSeek wire messages.
 * @param events - immutable canonical event suffix.
 * @param messages - serialized request messages that the receiver also holds.
 * @returns one raw-or-referenced representation per event.
 */
export function packSessionEvents(
  events: readonly SessionEvent[],
  messages: readonly DeepSeekLlmApiJson[],
): EncodedSessionEvent[] {
  // TODO: Index message strings if large opt-in suffixes show material request-preparation latency.
  const sources: MessageStringSource[] = []
  messages.forEach((message, messageIndex) => { collectSources(message, messageIndex, [], sources) })
  sources.sort((left, right) => right.bytes - left.bytes)
  return events.map((event) => {
    const packed = packValue(event as unknown as JsonValue, sources)
    const raw: EncodedSessionEvent = { encoding: 'raw', event }
    if (!packed.references) return raw
    const referenced: EncodedSessionEvent = { encoding: 'message-references', event: packed.value }
    return wireBytes(referenced) < wireBytes(raw) ? referenced : raw
  })
}

/**
 * Reconstruct canonical session events from one request-relative representation.
 * @param events - encoded event list from the extension field.
 * @param messages - serialized messages from the same request.
 * @returns reconstructed event values in order.
 */
export function unpackSessionEvents(
  events: readonly EncodedSessionEvent[],
  messages: readonly DeepSeekLlmApiJson[],
): SessionEvent[] {
  return events.map(encoded => encoded.encoding === 'raw'
    ? structuredClone(encoded.event)
    : unpackJsonValue(encoded.event, messages) as unknown as SessionEvent)
}
