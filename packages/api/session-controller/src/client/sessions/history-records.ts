/** Lossless client decoding for packed Assistant delta runs in history responses. */

import { decodeStorageRecord } from '@deepseek-ai/dsh-session/chunk-rows'
import type {
  SessionEventEntry,
  SessionHistoryRecord,
  SessionWireEvent,
} from '../../types.ts'

/**
 * Convert history wire records into exact event inputs for Conversation Definitions.
 * @param records - validated lossless history transport records.
 * @returns Ordinary entries unchanged and packed runs expanded member-for-member.
 */
export function historyEntries(records: readonly SessionHistoryRecord[]): SessionEventEntry[] {
  return records.flatMap(record => 'event' in record
    ? [record]
    : decodeStorageRecord(record.chunks).map(event => ({
      event: event as unknown as SessionWireEvent,
    })))
}
