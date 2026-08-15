/** Packed history record folding without token-by-token browser expansion. */

import { describe, expect, it } from 'vitest'
import { CallId } from '@deepseek-ai/dsh-llm/brand'
import type { ChunkRow } from '@deepseek-ai/dsh-session/chunk-rows'
import type { SessionHistoryRecord } from '../src/types.ts'
import { coalesceHistoryChunkRun, historyEntries } from '../src/client/sessions/history-records.ts'

describe('coalesceHistoryChunkRun', () => {
  it('preserves first-token and first-visible boundaries with at most two text events', () => {
    const row: ChunkRow = {
      type: 'text-chunks',
      seq0: 10,
      time0: 100,
      data: {
        turn: 2,
        step: 3,
        index: 0,
        dt: [1, 2, 3, 4],
        texts: ['', ' ', '', 'hello', ' world'],
      },
    }

    const events = coalesceHistoryChunkRun(row)
    expect(events).toHaveLength(2)
    expect(events.map(event => ({ seq: event.seq, time: event.time, text: event.data.chunk.type === 'text-delta' ? event.data.chunk.text : '' })))
      .toEqual([
        { seq: 11, time: 101, text: ' ' },
        { seq: 13, time: 106, text: 'hello world' },
      ])
    expect(events[0]?.time).toBe(101)
    expect(events.find(event => event.data.chunk.type === 'text-delta' && event.data.chunk.text.trim() !== '')?.time)
      .toBe(106)
  })

  it('joins visible reasoning members into one event at the first non-empty member', () => {
    const row: ChunkRow = {
      type: 'reasoning-chunks',
      seq0: 4,
      time0: 50,
      data: { turn: 1, step: 1, index: 2, dt: [5, 7], texts: ['', 'a', 'b'] },
    }
    const [event] = coalesceHistoryChunkRun(row)
    expect(event).toMatchObject({
      seq: 5,
      time: 55,
      data: { chunk: { type: 'reasoning-delta', index: 2, text: 'ab' } },
    })
  })

  it('joins tool arguments while retaining name presence and first-token time', () => {
    const named: ChunkRow = {
      type: 'tool-call-chunks',
      seq0: 20,
      time0: 200,
      data: {
        turn: 2,
        step: 4,
        index: 1,
        id: CallId('call-1'),
        name: 'write',
        dt: [2, 3],
        args: ['', '{"x":', '1}'],
      },
    }
    expect(coalesceHistoryChunkRun(named)).toMatchObject([{
      seq: 20,
      time: 200,
      data: { chunk: { type: 'tool-call-delta', name: 'write', argumentsDelta: '{"x":1}' } },
    }])

    const unnamed: ChunkRow = {
      type: 'tool-call-chunks',
      seq0: 20,
      time0: 200,
      data: {
        turn: 2,
        step: 4,
        index: 1,
        id: CallId('call-1'),
        dt: [2, 3],
        args: ['', '', 'x'],
      },
    }
    const [event] = coalesceHistoryChunkRun(unnamed)
    expect(event).toMatchObject({ seq: 22, time: 205, data: { chunk: { argumentsDelta: 'x' } } })
    expect(Object.hasOwn(event?.data.chunk ?? {}, 'name')).toBe(false)
  })
})

describe('historyEntries', () => {
  it('keeps ordinary entries and views while folding a packed run without expansion', () => {
    const ordinary = {
      event: { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      view: { for: 'call', view: { card: 'generic' } },
    } as unknown as SessionHistoryRecord
    const packed: SessionHistoryRecord = {
      chunks: {
        type: 'text-chunks',
        seq0: 1,
        time0: 2,
        data: { turn: 1, step: 1, index: 0, dt: [1, 1, 1], texts: ['a', 'b', 'c', 'd'] },
      },
    }
    const entries = historyEntries([ordinary, packed])
    expect(entries).toHaveLength(2)
    expect(entries[0]).toBe(ordinary)
    expect(entries[1]?.event).toMatchObject({ seq: 1, data: { chunk: { text: 'abcd' } } })
  })
})
