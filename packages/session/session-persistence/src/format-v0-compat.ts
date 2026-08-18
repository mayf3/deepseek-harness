/**
 * Same-version normalization for durable format-v0 Session records.
 * @module @deepseek-ai/dsh-session-persistence/format-v0-compat
 */

import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'

/** One format-specific normalizer selected before adjacent-version migrations. */
export interface UnversionedFormatCompatibility {
  /** Header version whose historical records require this normalizer. */
  readonly version: number
  /**
   * Whether converting one suffix record requires facts from earlier events.
   * @param value - parsed event JSON from a suffix read.
   * @returns whether the decoder must reopen the complete event stream.
   */
  requiresPrefix(value: unknown): boolean
  /**
   * Convert recognized historical records into the canonical representation
   * carrying the same version number.
   * @param events - parsed event JSON in durable sequence order.
   * @param sessionId - identity read from the stored header.
   * @returns a lazy stream in the canonical representation for {@link version}.
   */
  canonicalizeEvents(events: AsyncIterable<unknown>, sessionId: SessionId): AsyncIterable<unknown>
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function hasOnlyKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = [...required, ...optional]
  return Object.keys(record).every(key => allowed.includes(key))
    && required.every(key => Object.hasOwn(record, key))
}

type PersistedMessageId = SessionEvent<'user/message'>['data']['id']

function legacyMessageId(id: SessionId, seq: number): PersistedMessageId {
  return `legacy-message:${id}:${seq}` as PersistedMessageId
}

function replacementStart(event: SessionEvent): number | undefined {
  const op = asRecord((event as SessionEvent & { surfaceOp?: unknown }).surfaceOp)
  return op?.['op'] === 'replace' && typeof op['start'] === 'number'
    ? op['start']
    : undefined
}

function requiresV0Prefix(value: unknown): boolean {
  const event = asRecord(value)
  if (event === undefined) return false
  const data = asRecord(event['data'])
  if (event['type'] === 'steering/message') return true
  if (data === undefined) return false
  switch (event['type']) {
    case 'user/message':
      return !Object.hasOwn(data, 'id') && Object.hasOwn(data, 'content')
    case 'assistant/message':
      return !Object.hasOwn(data, 'message') && Object.hasOwn(data, 'content')
    case 'tool/result':
      return !Object.hasOwn(data, 'message') && Object.hasOwn(data, 'callId')
    default:
      return false
  }
}

function readV0Event(value: unknown, id: SessionId): SessionEvent {
  const event = asRecord(value)
  if (event === undefined) throw new Error(`session "${id}" contains a non-record event`)
  if (typeof event['type'] !== 'string') throw new Error(`session "${id}" contains an event without a string type`)
  if (!Number.isSafeInteger(event['seq']) || (event['seq'] as number) < 0) {
    throw new Error(`session "${id}" contains event type "${event['type']}" with invalid seq ${String(event['seq'])}`)
  }
  if (typeof event['time'] !== 'number' || !Number.isFinite(event['time'])) {
    throw new Error(`session "${id}" contains event type "${event['type']}" at seq ${String(event['seq'])} with invalid time`)
  }
  if (!Object.hasOwn(event, 'data')) {
    throw new Error(`session "${id}" contains event type "${event['type']}" at seq ${String(event['seq'])} without data`)
  }
  return event as unknown as SessionEvent
}

function canonicalizeLegacySteeringEvent(event: SessionEvent, id: SessionId): SessionEvent {
  const legacyType: string = 'steering/message'
  if (event.type !== legacyType) return event
  const data = asRecord(event.data)
  if (data === undefined) {
    throw new Error(`session "${id}" contains malformed pre-react-loop steering/message at seq ${event.seq}`)
  }
  const wrapped = asRecord(data['message'])
  if (wrapped !== undefined && Number.isSafeInteger(data['turn'])
    && hasOnlyKeys(data, ['turn', 'message'])) {
    return { ...event, type: 'user/message', data: wrapped } as SessionEvent
  }
  if (!Number.isSafeInteger(data['turn']) || !hasOnlyKeys(data, ['turn', 'content', 'source'])) {
    throw new Error(`session "${id}" contains malformed pre-react-loop steering/message at seq ${event.seq}`)
  }
  const { turn: _turn, ...message } = data
  return {
    ...event,
    type: 'user/message',
    data: { ...message, id: legacyMessageId(id, event.seq), role: 'user' },
  } as SessionEvent
}

function canonicalizeLegacyTurnStartEvent(event: SessionEvent, id: SessionId): SessionEvent {
  if (event.type !== 'turn/start') return event
  const data = asRecord(event.data)
  if (data === undefined || !Object.hasOwn(data, 'trigger')) return event
  const trigger = asRecord(data['trigger'])
  if (!Number.isSafeInteger(data['turn']) || (data['turn'] as number) < 1
    || !hasOnlyKeys(data, ['turn', 'trigger'])
    || trigger === undefined || typeof trigger['kind'] !== 'string' || trigger['kind'].length === 0) {
    throw new Error(`session "${id}" contains malformed pre-react-loop turn/start at seq ${event.seq}`)
  }
  return { ...event, data: { turn: data['turn'] } } as SessionEvent
}

function canonicalizeLegacyTurnEndEvent(event: SessionEvent, id: SessionId): SessionEvent {
  if (event.type !== 'turn/end') return event
  const data = asRecord(event.data)
  if (data === undefined) return event
  const malformed = (): never => {
    throw new Error(`session "${id}" contains malformed pre-react-loop turn/end at seq ${event.seq}`)
  }
  const reason = asRecord(data['reason'])
  if (!Number.isSafeInteger(data['turn']) || (data['turn'] as number) < 1
    || !hasOnlyKeys(data, ['turn', 'reason'])
    || reason === undefined || typeof reason['kind'] !== 'string') return malformed()

  let currentReason: Record<string, unknown> | undefined
  switch (reason['kind']) {
    case 'completed':
    case 'blocked':
    case 'max-tokens':
    case 'interrupted':
      if (!hasOnlyKeys(reason, ['kind'])) return malformed()
      return event
    case 'aborted':
      if (Object.hasOwn(reason, 'reason')) return event
      if (!hasOnlyKeys(reason, ['kind'])) return malformed()
      currentReason = { kind: 'aborted', reason: { kind: 'legacy' } }
      break
    case 'disposed':
      if (!hasOnlyKeys(reason, ['kind'])) return malformed()
      currentReason = { kind: 'aborted', reason: { kind: 'disposed' } }
      break
    case 'error': {
      if (Object.hasOwn(reason, 'error')) return event
      if (!Number.isSafeInteger(reason['step']) || (reason['step'] as number) < 0) return malformed()
      const failure = asRecord(reason['failure'])
      if (failure !== undefined && hasOnlyKeys(reason, ['kind', 'step', 'failure'])
        && hasOnlyKeys(failure, ['message', 'code'], ['status', 'providerRetryAfterMs', 'requestId'])
        && typeof failure['message'] === 'string' && typeof failure['code'] === 'string'
        && (failure['status'] === undefined || typeof failure['status'] === 'number')
        && (failure['providerRetryAfterMs'] === undefined || typeof failure['providerRetryAfterMs'] === 'number')
        && (failure['requestId'] === undefined || typeof failure['requestId'] === 'string')) {
        currentReason = { kind: 'error', error: failure }
        break
      }
      const messageKeys = reason['code'] === undefined
        ? ['kind', 'step', 'message']
        : ['kind', 'step', 'message', 'code']
      if (!hasOnlyKeys(reason, messageKeys)
        || typeof reason['message'] !== 'string'
        || (reason['code'] !== undefined && typeof reason['code'] !== 'string')) return malformed()
      currentReason = {
        kind: 'error',
        error: {
          message: reason['message'],
          code: typeof reason['code'] === 'string' ? reason['code'] : 'UNKNOWN',
        },
      }
      break
    }
    default:
      return event
  }
  return { ...event, data: { ...data, reason: currentReason } } as SessionEvent
}

function canonicalizeLegacyMessageEvent(
  event: SessionEvent,
  id: SessionId,
  messageIds: ReadonlyMap<number, PersistedMessageId>,
): SessionEvent {
  const data = asRecord(event.data)
  if (data === undefined) return event
  switch (event.type) {
    case 'user/message':
      if (Object.hasOwn(data, 'id') || Object.hasOwn(data, 'role')
        || Object.hasOwn(data, 'message')
        || !Object.hasOwn(data, 'content') || !Object.hasOwn(data, 'source')) return event
      return { ...event, data: { ...data, id: legacyMessageId(id, event.seq), role: 'user' } } as SessionEvent
    case 'assistant/message': {
      if (Object.hasOwn(data, 'message')
        || !Object.hasOwn(data, 'content') || !Object.hasOwn(data, 'provenance')) return event
      const { content, provenance, ...eventData } = data
      return {
        ...event,
        data: {
          ...eventData,
          message: {
            id: legacyMessageId(id, event.seq),
            role: 'assistant',
            content,
            source: { ...asRecord(provenance), kind: 'model' },
          },
        },
      } as SessionEvent
    }
    case 'tool/result': {
      if (Object.hasOwn(data, 'message')
        || !Object.hasOwn(data, 'callId') || !Object.hasOwn(data, 'content')
        || !Object.hasOwn(data, 'isError')) return event
      const { callId, content, isError, ...eventData } = data
      const inheritedId = replacementStart(event)
      return {
        ...event,
        data: {
          ...eventData,
          message: {
            id: inheritedId === undefined ? legacyMessageId(id, event.seq) : messageIds.get(inheritedId),
            role: 'user',
            content: [{ type: 'tool-result', toolCallId: callId, content, isError }],
            source: { kind: 'tool', callId },
          },
        },
      } as SessionEvent
    }
    default:
      return event
  }
}

function eventMessageId(event: SessionEvent): PersistedMessageId | undefined {
  const data = asRecord(event.data)
  const message = event.type === 'user/message' ? data : asRecord(data?.['message'])
  return typeof message?.['id'] === 'string' ? message['id'] as PersistedMessageId : undefined
}

async function* canonicalizeV0Events(
  events: AsyncIterable<unknown>,
  id: SessionId,
): AsyncIterable<unknown> {
  const messageIds = new Map<number, PersistedMessageId>()
  for await (const value of events) {
    const event = readV0Event(value, id)
    const turnStart = canonicalizeLegacyTurnStartEvent(event, id)
    const turnEnd = canonicalizeLegacyTurnEndEvent(turnStart, id)
    const steering = canonicalizeLegacySteeringEvent(turnEnd, id)
    const canonical = canonicalizeLegacyMessageEvent(steering, id, messageIds)
    const messageId = eventMessageId(canonical)
    if (messageId !== undefined) messageIds.set(canonical.seq, messageId)
    yield canonical
  }
}

/**
 * Durable v0 includes first-party records whose structural changes were not
 * accompanied by a format-version change. Their headers cannot select an
 * adjacent-version migration, so this exact legacy recognition runs before
 * any v0-to-v1 step and produces canonical v0 without changing the version.
 * It remains necessary while v0 is current and whenever v0 is an upgrade
 * source. Normalization alone is read-only; a selected versioned migration
 * causes the canonicalized events to participate in atomic replacement.
 */
const V0_UNVERSIONED_FORMAT_COMPATIBILITY: UnversionedFormatCompatibility = Object.freeze({
  version: 0,
  requiresPrefix: requiresV0Prefix,
  canonicalizeEvents: canonicalizeV0Events,
})

/**
 * Select same-version compatibility for one stored header version.
 * @param version - format version read from the stored header.
 * @returns the static normalizer for that version, if one is required.
 */
export function unversionedFormatCompatibility(
  version: number,
): UnversionedFormatCompatibility | undefined {
  return version === V0_UNVERSIONED_FORMAT_COMPATIBILITY.version
    ? V0_UNVERSIONED_FORMAT_COMPATIBILITY
    : undefined
}
