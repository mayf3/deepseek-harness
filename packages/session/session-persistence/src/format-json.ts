/** Shared JSON validation for stored Session format records. */

import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'

/**
 * Narrow an unknown JSON value to a non-array object.
 * @param value - parsed JSON value.
 * @returns the object, or `undefined` for every other JSON value.
 */
export function asStoredRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Validate fields common to every stored Session event envelope.
 * @param value - detached parsed event JSON.
 * @param id - Session identity used in diagnostics.
 * @returns the structurally valid event envelope.
 */
export function readStoredEventEnvelope(value: unknown, id: SessionId): SessionEvent {
  const event = asStoredRecord(value)
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

/**
 * Reject event records retired before the current durable event vocabulary.
 * @param event - current-envelope event presented for reading or writing.
 * @param id - Session identity used in diagnostics.
 */
export function assertNoRetiredSessionEvent(event: SessionEvent, id: SessionId): void {
  const retiredType: string = 'request/header-delta'
  if (event.type === retiredType) {
    throw new Error(`session "${id}" contains unsupported legacy request/header-delta event at seq ${event.seq}`)
  }
  const retiredModeType: string = 'mode/set'
  if (event.type === retiredModeType) {
    throw new Error(`session "${id}" contains unsupported legacy mode/set event at seq ${event.seq}`)
  }
  if (event.type === 'request/header'
    && (event.data as { reason?: string }).reason === 'fallback') {
    throw new Error(`session "${id}" contains unsupported legacy request/header reason "fallback" at seq ${event.seq}`)
  }
}
