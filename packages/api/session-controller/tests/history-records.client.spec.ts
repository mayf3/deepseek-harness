/** Packed history records decode to the exact Session event stream. */

import { describe, expect, it } from 'vitest'
import { CallId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionHistoryRecord } from '../src/types.ts'
import { historyEntries } from '../src/client/sessions/history-records.ts'

describe('historyEntries', () => {
  it('keeps ordinary entries and expands every packed text member with its exact boundary', () => {
    const ordinary = {
      event: { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    } as SessionHistoryRecord
    const packed: SessionHistoryRecord = {
      chunks: {
        type: 'text-chunks',
        seq0: 1,
        time0: 2,
        data: { turn: 1, step: 1, index: 0, dt: [1, 1, 1], texts: ['a', 'b', 'c', 'd'] },
      },
    }

    const entries = historyEntries([ordinary, packed])

    expect(entries).toHaveLength(5)
    expect(entries[0]).toBe(ordinary)
    expect(entries.slice(1).map(entry => ({
      seq: entry.event.seq,
      time: entry.event.time,
      chunk: entry.event.type === 'assistant/chunk' ? entry.event.data.chunk : undefined,
    }))).toEqual([
      { seq: 1, time: 2, chunk: { type: 'text-delta', index: 0, text: 'a' } },
      { seq: 2, time: 3, chunk: { type: 'text-delta', index: 0, text: 'b' } },
      { seq: 3, time: 4, chunk: { type: 'text-delta', index: 0, text: 'c' } },
      { seq: 4, time: 5, chunk: { type: 'text-delta', index: 0, text: 'd' } },
    ])
  })

  it('preserves every tool-call fragment and optional-name presence', () => {
    const packed: SessionHistoryRecord = {
      chunks: {
        type: 'tool-call-chunks',
        seq0: 20,
        time0: 200,
        data: {
          turn: 2,
          step: 4,
          index: 1,
          id: CallId('call-1'),
          dt: [2, 3],
          args: ['', '{"x":', '1}'],
        },
      },
    }

    const events = historyEntries([packed]).map(entry => entry.event)

    expect(events).toMatchObject([
      { seq: 20, time: 200, data: { chunk: { argumentsDelta: '' } } },
      { seq: 21, time: 202, data: { chunk: { argumentsDelta: '{"x":' } } },
      { seq: 22, time: 205, data: { chunk: { argumentsDelta: '1}' } } },
    ])
    expect(events.every(event => event.type === 'assistant/chunk'
      && !Object.hasOwn(event.data.chunk, 'name'))).toBe(true)
  })
})
