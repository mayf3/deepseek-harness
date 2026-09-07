import { describe, expect, it } from 'vitest'
import {
  SessionLogOffset,
  SessionSeq,
  SESSION_FORMAT_VERSION,
  SessionId,
} from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  subagentCatalogEntries,
  subagentCatalogProjectionDefinition,
} from '../src/catalog.ts'
import type { SubagentCatalogState } from '../src/catalog.ts'

const header: SessionHeader = {
  version: SESSION_FORMAT_VERSION,
  id: SessionId('catalog-parent'),
  createdAt: 0,
  isSeeded: false,
}

/** Fold one event list through the pure definition, as the registry does for a log. */
function fold(events: readonly SessionEvent[]): SubagentCatalogState {
  let state = subagentCatalogProjectionDefinition.init(header, SessionLogOffset(0))
  for (const event of events) state = subagentCatalogProjectionDefinition.apply(state, event)
  return state
}

function fact(
  seq: number,
  childId: string,
  childCreatedAt: number,
  descriptor:
    | { readonly mode: 'one-shot'; readonly label?: string }
    | { readonly mode: 'continuable'; readonly label: string },
): SessionEvent<'subagent/catalog'> {
  return {
    type: 'subagent/catalog',
    seq: SessionSeq(seq),
    time: 0,
    data: {
      version: 0,
      childId: SessionId(childId),
      childCreatedAt,
      ...descriptor,
    },
  }
}

describe('subagent catalog projection', () => {
  it('preserves earlier checkpoints across chunk rollover and restores every fact', () => {
    const first = fold(Array.from({ length: 64 }, (_, i) =>
      fact(i, `child-${i}`, i, { mode: 'one-shot' })))
    const checkpoint = JSON.stringify(first)
    let state = first
    for (let i = 64; i < 130; i += 1) {
      state = subagentCatalogProjectionDefinition.apply(
        state, fact(i, `child-${i}`, i, { mode: 'one-shot' }),
      )
    }
    const restored = subagentCatalogProjectionDefinition.stateSchema.parse(
      JSON.parse(JSON.stringify(state)),
    )

    expect(JSON.stringify(first)).toBe(checkpoint)
    expect(subagentCatalogEntries(first)).toHaveLength(64)
    expect(subagentCatalogEntries(restored).map(entry => entry.id))
      .toEqual(Array.from({ length: 130 }, (_, i) => SessionId(`child-${i}`)))
  })

  it('validates recursive chunk state and materializes every label variant in stable order', () => {
    const events: SessionEvent[] = [
      fact(0, 'child-b', 1, { mode: 'one-shot' }),
      fact(1, 'child-a', 1, { mode: 'one-shot', label: 'once' }),
      {
        type: 'subagent/catalog',
        seq: SessionSeq(2),
        time: 0,
        data: {
          version: 0,
          childId: SessionId('child-c'),
          childCreatedAt: 2,
          mode: 'continuable',
        },
      } as unknown as SessionEvent,
      fact(3, 'child-d', 3, { mode: 'continuable', label: 'later' }),
    ]
    const state = fold(events)

    expect(subagentCatalogProjectionDefinition.stateSchema.parse(JSON.parse(JSON.stringify(state))))
      .toEqual(state)
    expect(subagentCatalogEntries(state)).toEqual([
      { id: SessionId('child-a'), createdAt: 1, mode: 'one-shot', label: 'once' },
      { id: SessionId('child-b'), createdAt: 1, mode: 'one-shot' },
      { id: SessionId('child-d'), createdAt: 3, mode: 'continuable', label: 'later' },
    ])
  })

  it('ignores unrelated, inherited, and malformed events without changing state', () => {
    const seededHeader = { ...header, isSeeded: true }
    const initial = subagentCatalogProjectionDefinition.init(seededHeader, SessionLogOffset(2))
    const unrelated = subagentCatalogProjectionDefinition.apply(initial, {
      type: 'turn/start', seq: SessionSeq(2), time: 0, data: { turn: 1 },
    })
    const inherited = subagentCatalogProjectionDefinition.apply(
      unrelated,
      fact(1, 'inherited', 1, { mode: 'one-shot' }),
    )
    const malformed = subagentCatalogProjectionDefinition.apply(inherited, {
      type: 'subagent/catalog', seq: SessionSeq(2), time: 0, data: { version: 9 },
    } as unknown as SessionEvent)

    expect(unrelated).toBe(initial)
    expect(inherited).toBe(initial)
    expect(malformed).toBe(initial)
  })
})
