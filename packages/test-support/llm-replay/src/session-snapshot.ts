/**
 * Private parser support for replay session fixtures.
 * @module @deepseek-ai/dsh-llm-replay/session-snapshot
 */

import { decodeStorageRecord, type SessionEvent } from '@deepseek-ai/dsh-session'

const PACKED_CHUNK_ROW_TYPES = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks'])

function parseJsonl(text: string): Record<string, unknown>[] {
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
    return [{ ...value }]
  })
}

function envelopeKeys(record: Record<string, unknown>): readonly [string, string] {
  return typeof record.type === 'string' && PACKED_CHUNK_ROW_TYPES.has(record.type)
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
 * Parse a persisted or uniformly projected session fixture for replay.
 * Missing body envelopes are synthesized only for the returned event list;
 * projected and persisted rows cannot coexist in one fixture.
 *
 * @param text - session JSONL contents.
 * @returns logical events expanded from ordinary and packed body rows.
 */
export function parseReplaySessionLog(text: string): SessionEvent[] {
  const records = parseJsonl(text)
  if (records[0]?.type !== 'session') throw new Error('session snapshot must start with a session header')

  const events: SessionEvent[] = []
  let nextSeq = 0
  let projected: boolean | undefined
  for (const [index, record] of records.slice(1).entries()) {
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
      /* v8 ignore next -- decodeStorageRecord only throws Error instances; the String arm only satisfies the unknown narrowing. */
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`session snapshot line ${index + 2}: ${detail}`, { cause: error })
    }
    events.push(...decoded)
    nextSeq += decoded.length
  }
  return events
}
