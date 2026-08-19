/**
 * Session snapshot projection and decoding for replay fixtures.
 * @module @deepseek-ai/dsh-llm-replay/session-snapshot
 */

import { decodeStorageRecord, type SessionEvent } from '@deepseek-ai/dsh-session'

const PACKED_CHUNK_ROW_TYPES = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks'])

/** A decoded replay fixture with storage envelopes materialized in memory. */
export interface DecodedSessionSnapshot {
  /** Parsed session header. */
  header: Record<string, unknown>
  /** Original header line, retained byte-for-byte by projection. */
  headerLine: string
  /** Parsed body rows with sequence/time envelopes present. */
  bodyRecords: Record<string, unknown>[]
  /** Logical events expanded from ordinary and packed body rows. */
  events: SessionEvent[]
}

interface JsonlRecord {
  text: string
  value: Record<string, unknown>
}

function parseJsonl(text: string): JsonlRecord[] {
  return text.split(/\r?\n/).flatMap((line, index) => {
    if (line.trim().length === 0) return []
    let value: unknown
    try {
      value = JSON.parse(line) as unknown
    } catch (error) {
      throw new Error(`session snapshot line ${index + 1} contains invalid JSON: ${String(error)}`, { cause: error })
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`session snapshot line ${index + 1} must be a JSON object`)
    }
    return [{ text: line, value: value as Record<string, unknown> }]
  })
}

/**
 * Test whether a parsed storage or snapshot row is a packed chunk run.
 *
 * @param record - parsed session body record.
 * @returns whether the row uses the packed chunk representation.
 */
export function isPackedSessionChunkRow(record: Record<string, unknown>): boolean {
  return typeof record.type === 'string' && PACKED_CHUNK_ROW_TYPES.has(record.type)
}

function envelopeKeys(record: Record<string, unknown>): readonly [string, string] {
  return isPackedSessionChunkRow(record)
    ? ['seq0', 'time0']
    : ['seq', 'time']
}

/** Insert a synthetic envelope after the discriminant without reparsing the row. */
function insertSyntheticEnvelope(
  record: Record<string, unknown>,
  seqKey: string,
  timeKey: string,
  seq: number,
): void {
  const entries = Object.entries(record)
  for (const key of Object.keys(record)) Reflect.deleteProperty(record, key)
  let inserted = false
  for (const [key, value] of entries) {
    record[key] = value
    if (key === 'type') {
      record[seqKey] = seq
      record[timeKey] = 0
      inserted = true
    }
  }
  if (!inserted) {
    record[seqKey] = seq
    record[timeKey] = 0
  }
}

/**
 * Omit a body record's persistence-only sequence/time envelope in place.
 * Deleting all four possible keys keeps snapshot serialization independent of
 * the record discriminant while leaving nested payload fields untouched.
 *
 * @param record - parsed session body record owned by the caller.
 */
export function omitSessionEventEnvelope(record: Record<string, unknown>): void {
  delete record.seq
  delete record.time
  delete record.seq0
  delete record.time0
}

/**
 * Materialize missing sequence/time envelopes on parsed snapshot body records.
 * The records are mutated in place and decoded in storage order.
 *
 * @param records - parsed session body records owned by the caller.
 * @returns logical events expanded from ordinary and packed body rows.
 */
export function decodeSessionSnapshotBody(records: readonly Record<string, unknown>[]): SessionEvent[] {
  const events: SessionEvent[] = []
  let nextSeq = 0
  let projected: boolean | undefined
  for (const [index, record] of records.entries()) {
    const [seqKey, timeKey] = envelopeKeys(record)
    const hasSeq = Object.hasOwn(record, seqKey)
    const hasTime = Object.hasOwn(record, timeKey)
    if (hasSeq !== hasTime) {
      throw new Error(`session snapshot line ${index + 2} must carry both ${seqKey}/${timeKey} or neither`)
    }
    if (projected === undefined) projected = !hasSeq
    else if (projected === hasSeq) {
      throw new Error(`session snapshot line ${index + 2} cannot mix projected and persisted body records`)
    }
    if (projected) insertSyntheticEnvelope(record, seqKey, timeKey, nextSeq)
    let decoded: SessionEvent[]
    try {
      decoded = decodeStorageRecord(record)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`session snapshot line ${index + 2}: ${detail}`, { cause: error })
    }
    for (const event of decoded) events.push(event)
    nextSeq += decoded.length
  }
  return events
}

/**
 * Decode a committed session snapshot or a complete persisted session log.
 * Snapshot body rows may all omit both members of their sequence/time
 * envelope; decoding restores a contiguous synthetic envelope without
 * changing payloads. Projected and persisted rows cannot coexist in one file.
 *
 * @param text - session JSONL contents.
 * @returns the header, materialized body rows, and logical events.
 */
export function decodeSessionSnapshot(text: string): DecodedSessionSnapshot {
  const records = parseJsonl(text)
  const header = records[0]
  if (header === undefined || header.value.type !== 'session') {
    throw new Error('session snapshot must start with a session header')
  }

  const bodyRecords = records.slice(1).map(({ value }) => value)
  const events = decodeSessionSnapshotBody(bodyRecords)

  return {
    header: header.value,
    headerLine: header.text,
    bodyRecords,
    events,
  }
}

/**
 * Project persisted session JSONL into the committed replay-fixture format.
 * The header line and all body payloads remain unchanged; only ordinary
 * `seq`/`time` and packed-row `seq0`/`time0` envelopes are omitted.
 *
 * @param text - persisted or already-projected session JSONL.
 * @returns compact projected body JSONL with the original header line.
 */
export function projectSessionSnapshot(text: string): string {
  const records = parseJsonl(text)
  const header = records[0]
  if (header === undefined || header.value.type !== 'session') {
    throw new Error('session snapshot must start with a session header')
  }
  const body = records.slice(1).map(({ value }) => {
    omitSessionEventEnvelope(value)
    return JSON.stringify(value)
  })
  return [header.text, ...body, ''].join('\n')
}
