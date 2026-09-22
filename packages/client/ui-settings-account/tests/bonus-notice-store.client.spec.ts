// @vitest-environment jsdom
/**
 * The local bonus record is what keeps a shown award from appearing twice. It
 * therefore has to survive a storage write that fails while the page keeps
 * running, and it has to ignore anything it did not write.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AccountBonusOrderId, AccountUserId } from '@deepseek-ai/dsh-deepseek-account/types'
import { bonusNoticeStorageKey, createBonusNoticeStore } from '../src/client/bonus-notice-store.ts'

const ORDER = 'order-1' as AccountBonusOrderId

/**
 * Storage keys are the isolation unit for this module: records of a page whose
 * browser storage was refused live in a module-level map keyed the same way, so
 * one key per case keeps that page-lifetime state from leaking between cases.
 * @param account - account name distinguishing this case's key.
 * @returns the record key for that account.
 */
function keyFor(account: string): string {
  return bonusNoticeStorageKey('https://platform.test', account as AccountUserId)
}

/** @param overrides - storage members to replace. @returns a storage stub the store accepts. */
function storage(overrides: Partial<Storage>): Storage {
  return { getItem: () => null, setItem: () => {}, clear: () => {}, ...overrides } as unknown as Storage
}

beforeEach(() => { localStorage.clear() })
afterEach(() => { vi.restoreAllMocks() })

it('records and re-reads a shown order through browser storage', () => {
  const KEY = keyFor('browser-storage')
  const first = createBonusNoticeStore(KEY)
  expect(first.state(ORDER)).toBeUndefined()
  first.write(ORDER, 'pending')
  expect(first.state(ORDER)).toBe('pending')
  expect(first.pending()).toEqual([ORDER])
  // A later open reads the stored record rather than starting over.
  const second = createBonusNoticeStore(KEY)
  expect(second.state(ORDER)).toBe('pending')
  second.write(ORDER, 'acknowledged')
  expect(second.pending()).toEqual([])
  expect(createBonusNoticeStore(KEY).state(ORDER)).toBe('acknowledged')
})

it('prefers this page\'s records after a write storage refused, instead of the stale stored copy', () => {
  const KEY = keyFor('write-refused')
  const setItem = vi.fn(() => { throw new Error('quota exceeded') })
  vi.spyOn(globalThis, 'localStorage', 'get').mockReturnValue(storage({ setItem }))
  const first = createBonusNoticeStore(KEY)
  first.write(ORDER, 'pending')
  expect(setItem).toHaveBeenCalledOnce()
  // Storage still holds nothing, so a second open must not resurrect the award.
  const second = createBonusNoticeStore(KEY)
  expect(second.state(ORDER)).toBe('pending')
  expect(second.pending()).toEqual([ORDER])
})

it('falls back to page-lifetime records when the browser denies storage', () => {
  const KEY = keyFor('storage-denied')
  vi.spyOn(globalThis, 'localStorage', 'get').mockImplementation(() => { throw new Error('blocked') })
  const first = createBonusNoticeStore(KEY)
  first.write(ORDER, 'acknowledged')
  expect(first.state(ORDER)).toBe('acknowledged')
  // Signing out and back in during one page load still sees the record.
  expect(createBonusNoticeStore(KEY).state(ORDER)).toBe('acknowledged')
})

it('keeps records in memory when a storage read is denied', () => {
  const KEY = keyFor('read-denied')
  const getItem = vi.fn(() => { throw new Error('blocked') })
  vi.spyOn(globalThis, 'localStorage', 'get').mockReturnValue(storage({ getItem }))
  const store = createBonusNoticeStore(KEY)
  expect(store.pending()).toEqual([])
  store.write(ORDER, 'pending')
  expect(createBonusNoticeStore(KEY).state(ORDER)).toBe('pending')
})

it.each([
  ['an array', '[{"order-1":"pending"}]'],
  ['a scalar', '"pending"'],
  ['malformed JSON', '{not json'],
])('ignores %s left under its key', (_label, raw) => {
  const KEY = keyFor(`unusable-${_label}`)
  vi.spyOn(globalThis, 'localStorage', 'get').mockReturnValue(storage({ getItem: () => raw }))
  expect(createBonusNoticeStore(KEY).state(ORDER)).toBeUndefined()
})

it('drops entries that are not order ids with a known state', () => {
  const KEY = keyFor('unknown-state')
  vi.spyOn(globalThis, 'localStorage', 'get').mockReturnValue(storage({
    getItem: () => JSON.stringify({ '': 'pending', 'order-1': 'expired', 'order-2': 'pending' }),
  }))
  const store = createBonusNoticeStore(KEY)
  expect(store.state(ORDER)).toBeUndefined()
  expect(store.pending()).toEqual(['order-2'])
})
