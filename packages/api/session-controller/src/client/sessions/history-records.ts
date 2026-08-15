/** Compact client folding for packed Assistant delta runs in history responses. */

import type { ChunkRow } from '@deepseek-ai/dsh-session/chunk-rows'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {
  SessionEventEntry,
  SessionHistoryRecord,
} from '../../types.ts'

/** Resolve one packed member's original timestamp from the row's delta gaps. */
function memberTime(row: ChunkRow, index: number): number {
  let time = row.time0
  for (let cursor = 0; cursor < index; cursor++) time += row.data.dt[cursor] as number
  return time
}

/** Build one coalesced text or reasoning event from a contiguous member slice. */
function textEvent(
  row: Extract<ChunkRow, { type: 'text-chunks' | 'reasoning-chunks' }>,
  start: number,
  text: string,
): SessionEvent<'assistant/chunk'> {
  return {
    type: 'assistant/chunk',
    seq: row.seq0 + start,
    time: memberTime(row, start),
    data: {
      turn: row.data.turn,
      step: row.data.step,
      chunk: row.type === 'text-chunks'
        ? { type: 'text-delta', index: row.data.index, text }
        : { type: 'reasoning-delta', index: row.data.index, text },
    },
  }
}

/**
 * Coalesce one packed run into the smallest event set that preserves the
 * conversation fold's accumulated content, first-token time, and first
 * non-whitespace visibility boundary. Exact token boundaries remain available
 * in the wire row to consumers that explicitly decode it.
 * @param row - one validated packed history record.
 * @returns At most two Assistant chunk events for the ordinary UI fold.
 */
export function coalesceHistoryChunkRun(row: ChunkRow): SessionEvent<'assistant/chunk'>[] {
  if (row.type === 'tool-call-chunks') {
    const firstToken = row.data.name === undefined
      ? row.data.args.findIndex(fragment => fragment !== '')
      : 0
    const start = firstToken < 0 ? 0 : firstToken
    return [{
      type: 'assistant/chunk',
      seq: row.seq0 + start,
      time: memberTime(row, start),
      data: {
        turn: row.data.turn,
        step: row.data.step,
        chunk: {
          type: 'tool-call-delta',
          index: row.data.index,
          id: row.data.id,
          ...row.data.name === undefined ? {} : { name: row.data.name },
          argumentsDelta: row.data.args.join(''),
        },
      },
    }]
  }

  const texts = row.data.texts
  const firstToken = texts.findIndex(text => text !== '')
  const tokenStart = firstToken < 0 ? 0 : firstToken
  let visibleStart = -1
  let accumulated = ''
  for (let index = 0; index < texts.length; index++) {
    accumulated += texts[index] as string
    if (accumulated.trim() !== '') {
      visibleStart = index
      break
    }
  }
  if (visibleStart > tokenStart) {
    return [
      textEvent(row, tokenStart, texts.slice(0, visibleStart).join('')),
      textEvent(row, visibleStart, texts.slice(visibleStart).join('')),
    ]
  }
  return [textEvent(row, tokenStart, texts.join(''))]
}

/**
 * Convert history wire records into compact event inputs for the ordinary UI.
 * @param records - validated lossless history transport records.
 * @returns Ordinary entries unchanged and packed runs coalesced for folding.
 */
export function historyEntries(records: readonly SessionHistoryRecord[]): SessionEventEntry[] {
  return records.flatMap(record => 'event' in record
    ? [record]
    : coalesceHistoryChunkRun(record.chunks).map(event => ({ event })))
}
