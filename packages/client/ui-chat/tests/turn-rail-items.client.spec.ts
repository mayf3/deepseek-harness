// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { mergeTurnRailItems } from '../src/client/chat/turn-rail-items.ts'
import type { TurnNavigationItem } from '../src/client/contract/snapshot.ts'

function loadedItem(turn: number, prompt = `p${String(turn)}`, response = `r${String(turn)}`): TurnNavigationItem {
  return { turn, anchorKey: `anchor-${String(turn)}`, prompt, response }
}

describe('mergeTurnRailItems', () => {
  it('returns a stable empty array when both sides are empty', () => {
    expect(mergeTurnRailItems([], undefined)).toBe(mergeTurnRailItems([], { turns: [] }))
  })

  it('maps outline-only turns to unloaded marks in ascending order', () => {
    const items = mergeTurnRailItems([], {
      turns: [
        { turn: 1, seq: 0, prompt: 'first' },
        { turn: 2, seq: 9, prompt: '' },
      ],
    })
    expect(items).toEqual([
      { turn: 1, prompt: 'first', response: '', anchor: { kind: 'unloaded', seq: 0 } },
      { turn: 2, prompt: '', response: '', anchor: { kind: 'unloaded', seq: 9 } },
    ])
  })

  it('prefers the loaded side on overlap but falls back to the outline prompt for a mid-Turn window head', () => {
    const items = mergeTurnRailItems(
      [loadedItem(2, '', 'answer two'), loadedItem(3)],
      {
        turns: [
          { turn: 1, seq: 0, prompt: 'one' },
          { turn: 2, seq: 8, prompt: 'two from outline' },
          { turn: 3, seq: 16, prompt: 'three from outline' },
        ],
      },
    )
    expect(items).toEqual([
      { turn: 1, prompt: 'one', response: '', anchor: { kind: 'unloaded', seq: 0 } },
      { turn: 2, prompt: 'two from outline', response: 'answer two', anchor: { kind: 'loaded', key: 'anchor-2' } },
      { turn: 3, prompt: 'p3', response: 'r3', anchor: { kind: 'loaded', key: 'anchor-3' } },
    ])
  })

  it('passes loaded turns through when the outline is absent or lagging', () => {
    expect(mergeTurnRailItems([loadedItem(7)], undefined)).toEqual([
      { turn: 7, prompt: 'p7', response: 'r7', anchor: { kind: 'loaded', key: 'anchor-7' } },
    ])
    expect(mergeTurnRailItems([loadedItem(4)], { turns: [{ turn: 3, seq: 1, prompt: 'older' }] })).toEqual([
      { turn: 3, prompt: 'older', response: '', anchor: { kind: 'unloaded', seq: 1 } },
      { turn: 4, prompt: 'p4', response: 'r4', anchor: { kind: 'loaded', key: 'anchor-4' } },
    ])
  })

  it('drops malformed wire entries and shapes without folding the rail', () => {
    expect(mergeTurnRailItems([loadedItem(1)], 'not an outline')).toEqual([
      { turn: 1, prompt: 'p1', response: 'r1', anchor: { kind: 'loaded', key: 'anchor-1' } },
    ])
    const items = mergeTurnRailItems([], {
      turns: [
        { turn: -1, seq: 0, prompt: 'negative turn' },
        { turn: 2, seq: 0.5, prompt: 'fractional seq' },
        { turn: 3, seq: 4, prompt: 5 },
        { turn: 6, seq: 7, prompt: 'kept' },
        null,
      ],
    })
    expect(items).toEqual([
      { turn: 6, prompt: 'kept', response: '', anchor: { kind: 'unloaded', seq: 7 } },
    ])
  })
})
