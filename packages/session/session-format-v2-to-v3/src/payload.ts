/** Audited V2 migration admission and V3 payload validation, independent of installed core Session types. */

import { SessionFormatError, SessionFormatUnsupportedMigrationError, isSessionFormatJsonObject, sessionFormatCount, sessionFormatSafeInteger } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent, SessionFormatJsonObject, SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'
import { assertReleasedPayloadSemantics, assertReleasedSurfaceMetadata } from '@deepseek-ai/dsh-session-format-v0-to-v1'
import { RELEASED_V2_EVENT_DISPOSITIONS } from '@deepseek-ai/dsh-session-format-v1-to-v2'

/** Audited surface event names; all other admitted events are log-only. */
export const SURFACE_TYPES: ReadonlySet<string> = new Set(['system/message', 'user/message', 'assistant/message', 'tool/result'])
const SOURCE_KINDS = new Set(['user', 'plugin', 'model', 'tool', 'agent-instructions', 'session-reference', 'team-message', 'goal', 'skill-invocation', 'skill-catalog', 'coordinator', 'subagent-report', 'subagent-settled', 'webhook', 'agent-message'])

/**
 * Require a JSON object at the durable input boundary.
 * @param value - decoded value.
 * @param label - diagnostic subject.
 * @returns the narrowed object.
 */
export function record(value: SessionFormatJsonValue | undefined, label: string): SessionFormatJsonObject {
  if (!isSessionFormatJsonObject(value)) throw new SessionFormatError(label + ' must be an object')
  return value
}

/**
 * Reject missing and unaudited members rather than guessing whether they contain coordinates.
 * @param value - decoded record.
 * @param required - required member names.
 * @param optional - additional admitted names.
 * @param label - diagnostic subject.
 */
export function keys(value: SessionFormatJsonObject, required: readonly string[], optional: readonly string[], label: string): void {
  const missing = required.find(key => !Object.hasOwn(value, key))
  const unexpected = Object.keys(value).find(key => !required.includes(key) && !optional.includes(key))
  if (missing !== undefined) throw new SessionFormatError(label + ' lacks required field ' + missing)
  if (unexpected !== undefined) throw new SessionFormatError(label + ' has unexpected field ' + unexpected)
}

/**
 * Validate classified payloads before migration, or native V3 system/header payloads.
 * @param event - decoded logical event.
 * @param version - source or target generation.
 */
export function assertEvent(event: SessionFormatEvent, version: 2 | 3): void {
  const system = version === 3 && event.type === 'system/message'
  const disposition = RELEASED_V2_EVENT_DISPOSITIONS[event.type]
  const feedback = event.type === 'feedback/message-put' || event.type === 'feedback/message-delete'
  if (disposition === undefined && !system && !feedback) {
    throw new SessionFormatUnsupportedMigrationError('format v2 to v3 cannot safely transform unclassified event ' + event.type)
  }
  const surface = SURFACE_TYPES.has(event.type)
  keys(event, ['type', 'seq', 'time', 'data'], surface ? ['ignorable', 'sourceEventSeqs', 'surfaceOp'] : ['ignorable'], event.type)
  sessionFormatCount(event.seq, 'event seq')
  sessionFormatSafeInteger(event.time, 'event time')
  if (event['ignorable'] !== undefined && event['ignorable'] !== true) throw new SessionFormatError('ignorable must be true')
  if (surface) {
    assertReleasedSurfaceMetadata(event, event.seq, event.type, 'forbid-assistant')
    if (event['surfaceOp'] === undefined) throw new SessionFormatError(event.type + ' requires surfaceOp')
  }
  const data = record(event.data, event.type + ' data')
  if (system) {
    assertSystem(event, data)
    return
  }
  if (feedback) {
    assertFeedback(event.type, data)
    return
  }
  if (version === 3 && event.type === 'request/header') {
    assertV3StructuralRow(event)
    return
  }
  // Non-inventory system and feedback events have returned above.
  const admitted = disposition as NonNullable<typeof disposition>
  keys(data, admitted.required, admitted.optional, event.type + ' data')
  // Assistant attempts are introduced by V2; the V0 helper has no case for them.
  if (event.type !== 'assistant/attempt') assertReleasedPayloadSemantics(event, version)
  if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
    if (!Array.isArray(data['stream'])) throw new SessionFormatError('assistant stream must be an array')
    for (const coordinate of ['turn', 'step']) {
      if (sessionFormatCount(data[coordinate], coordinate) === 0) throw new SessionFormatError(coordinate + ' must be positive')
    }
  }
  if (event.type === 'session/end-seed' && data['inherited'] !== undefined && data['inherited'] !== true) {
    throw new SessionFormatError('session/end-seed inherited must be true')
  }
  // These are the only payload positions containing Harness messages. Tool JSON and stream
  // records are owner-opaque; their counters and serialized text are not local Session refs.
  if (version === 3) return
  if (event.type === 'user/message') assertSource(data)
  if (event.type === 'assistant/message' || event.type === 'tool/result') assertSource(record(data['message'], 'message'))
  if (event.type === 'tool/result' && isSessionFormatJsonObject(data['error']) && data['error']['code'] === 'TOOL_NOT_STARTED') {
    const message = record(data['message'], 'tool result message')
    const source = record(message['source'], 'tool result source')
    if (!isRepairIdentity(message['id'], source['callId'])) {
      throw new SessionFormatError('TOOL_NOT_STARTED repair requires its canonical historical message id')
    }
  }
  if (event.type === 'agent/inbox/spliced' || event.type === 'session/title-llm-request') {
    const messages = data[event.type === 'agent/inbox/spliced' ? 'inserted' : 'messages']
    for (const message of messages as readonly SessionFormatJsonObject[]) assertSource(message)
  }
}

/**
 * Recognize stable generated repair IDs without interpreting their historical suffix as a current coordinate.
 * @param id - durable message identity.
 * @param callId - advertised tool identity.
 * @returns whether the identity has the canonical historical repair form.
 */
export function isRepairIdentity(id: SessionFormatJsonValue | undefined, callId: SessionFormatJsonValue | undefined): callId is string {
  if (typeof callId !== 'string') return false
  const prefix = 'interrupted-tool-result-' + callId + '-'
  if (typeof id !== 'string' || !id.startsWith(prefix)) return false
  const suffix = id.slice(prefix.length)
  return /^(0|[1-9]\d*)$/.test(suffix) && Number.isSafeInteger(Number(suffix))
}

function assertSource(message: SessionFormatJsonObject): void {
  const source = record(message['source'], 'message source')
  if (typeof source['kind'] !== 'string' || !SOURCE_KINDS.has(source['kind'])) {
    throw new SessionFormatUnsupportedMigrationError('cannot safely transform unclassified message source')
  }
  if (source['kind'] === 'agent-message') {
    keys(source, ['kind', 'form', 'senderSessionId'], [], 'agent-message source')
    if (source['form'] !== 'relay' || typeof source['senderSessionId'] !== 'string' || source['senderSessionId'].length === 0) {
      throw new SessionFormatError('agent-message source requires relay form and senderSessionId')
    }
  }
  assertContentKinds(message['content'])
}

function assertContentKinds(content: SessionFormatJsonValue | undefined): void {
  // The frozen payload validator already checks content arrays, including nested tool results.
  for (const value of content as readonly SessionFormatJsonValue[]) {
    const block = record(value, 'message content')
    switch (block['type']) {
      case 'text':
      case 'reasoning':
      case 'image':
      case 'tool-call':
        break
      case 'file': {
        keys(block, ['type', 'attachment'], [], 'file content')
        const attachment = record(block['attachment'], 'file attachment')
        keys(attachment, ['attachmentId', 'name', 'bytes'], [], 'file attachment')
        if (typeof attachment['attachmentId'] !== 'string' || attachment['attachmentId'].length === 0
          || typeof attachment['name'] !== 'string') throw new SessionFormatError('file attachment requires attachmentId and name')
        sessionFormatCount(attachment['bytes'], 'file attachment bytes')
        break
      }
      case 'tool-result':
        assertContentKinds(block['content'])
        break
      default:
        throw new SessionFormatUnsupportedMigrationError('cannot safely transform unclassified message content')
    }
  }
}

/**
 * Reject V3 structural payload violations even beyond a recoverable physical-row failure.
 * @param value - raw physical row; ordinary rows retain the frozen decoder's recovery policy.
 */
export function assertV3StructuralRow(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return
  const row = value as SessionFormatJsonObject
  if (row['type'] === 'request/header') {
    const data = record(row['data'], 'request/header data')
    if (Object.hasOwn(record(data['header'], 'request header'), 'system')) {
      throw new SessionFormatError('format v3 request/header rejects retired header.system')
    }
  } else if (row['type'] === 'system/message') {
    const data = record(row['data'], 'system/message data')
    assertSystem({ type: 'system/message', seq: 0, time: 0, data }, data)
  }
}

function assertSystem(event: SessionFormatEvent, data: SessionFormatJsonObject): void {
  keys(data, ['turn', 'step', 'message'], [], 'system/message data')
  for (const coordinate of ['turn', 'step']) {
    if (sessionFormatCount(data[coordinate], coordinate) === 0) throw new SessionFormatError(coordinate + ' must be positive')
  }
  const message = record(data['message'], 'system message')
  keys(message, ['id', 'role', 'source', 'content'], [], 'system message')
  if (typeof message['id'] !== 'string' || message['id'].length === 0 || message['role'] !== 'system') {
    throw new SessionFormatError('system message requires an id and system role')
  }
  const source = record(message['source'], 'system source')
  if (source['kind'] !== 'plugin' || typeof source['plugin'] !== 'string' || source['plugin'].length === 0) {
    throw new SessionFormatError('system message requires plugin source')
  }
  assertReleasedPayloadSemantics({ ...event, type: 'user/message', data: { ...message, role: 'user' } }, 3)
}

function assertFeedback(type: string, data: SessionFormatJsonObject): void {
  keys(data, type === 'feedback/message-put' ? ['sessionId', 'item'] : ['sessionId', 'messageId'], [], type)
  if (typeof data['sessionId'] !== 'string') throw new SessionFormatError('feedback sessionId must be a string')
  if (type === 'feedback/message-delete') {
    if (typeof data['messageId'] !== 'string') throw new SessionFormatError('feedback messageId must be a string')
    return
  }
  const item = record(data['item'], 'feedback item')
  keys(item, ['messageId', 'rating', 'version', 'createdAt', 'updatedAt'], ['note'], 'feedback item')
  for (const key of ['messageId', 'version']) if (typeof item[key] !== 'string') throw new SessionFormatError('feedback ' + key + ' must be a string')
  if (item['rating'] !== 'positive' && item['rating'] !== 'negative') throw new SessionFormatError('invalid feedback rating')
  if (item['note'] !== undefined && typeof item['note'] !== 'string') throw new SessionFormatError('feedback note must be a string')
  sessionFormatCount(item['createdAt'], 'feedback createdAt')
  sessionFormatCount(item['updatedAt'], 'feedback updatedAt')
}
