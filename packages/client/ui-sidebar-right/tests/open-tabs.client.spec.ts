// @vitest-environment jsdom
/** Dormant saved layouts expose only provider metadata, with in-window stores authoritative. */
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TabRecord } from '@deepseek-ai/dsh-client-ui-dockkit'
import { OpenSidebarTabs, sidebarPersistence } from '../src/client/open-tabs.ts'

afterEach(() => { localStorage.clear(); vi.restoreAllMocks() })
const session = 'inactive-session' as SessionId
const tab = { id: 'terminal-tab', kind: 'terminal', contentId: 'terminal-page', title: 'Terminal' } as TabRecord
function save(id: SessionId, tabs: Record<string, unknown>): void {
  localStorage.setItem(`${sidebarPersistence}.${id}`, JSON.stringify({ bySession: { [id]: { layout: { tabs, expanded: false } } } }))
}

it('inventories collapsed and inactive saved Sessions without creating occurrences or resources', () => {
  save(session, { [tab.id]: tab })
  const other = 'other-session' as SessionId
  save(other, { file: { ...tab, id: 'file', kind: 'documentPreview', contentId: '/a.ts' } })
  localStorage.setItem('unrelated', 'broken')
  const inventory = new OpenSidebarTabs()
  expect(inventory.source.getSnapshot()).toEqual([
    { sessionId: session, tabId: tab.id, kind: tab.kind, contentId: tab.contentId },
    { sessionId: other, tabId: 'file', kind: 'documentPreview', contentId: '/a.ts' },
  ])
})

it('isolates corrupt records and whole layouts while retaining valid metadata', () => {
  save(session, { [tab.id]: tab, wrongId: tab, missingKind: { id: 'missingKind' }, array: [] })
  localStorage.setItem(`${sidebarPersistence}.broken-json`, '{')
  localStorage.setItem(`${sidebarPersistence}.missing-tabs`, '{"bySession":null}')
  const inventory = new OpenSidebarTabs()
  expect(inventory.source.getSnapshot()).toHaveLength(1)
  inventory.remove(session)
  expect(inventory.source.getSnapshot()).toEqual([])
})

it('keeps stable membership across title and layout changes and ignores another window storage writes', () => {
  save(session, { [tab.id]: tab })
  const inventory = new OpenSidebarTabs()
  const snapshot = inventory.source.getSnapshot()
  inventory.update(session, [{ ...tab, title: 'Renamed' }])
  expect(inventory.source.getSnapshot()).toBe(snapshot)
  save(session, {})
  window.dispatchEvent(new StorageEvent('storage', { key: `${sidebarPersistence}.${session}` }))
  expect(inventory.source.getSnapshot()).toBe(snapshot)
  inventory.update(session, [])
  expect(inventory.source.getSnapshot()).toEqual([])
})

it('publishes in-memory membership even when browser storage is inaccessible', () => {
  vi.spyOn(Storage.prototype, 'length', 'get').mockImplementation(() => { throw new Error('storage blocked') })
  const inventory = new OpenSidebarTabs()
  inventory.update(session, [tab])
  expect(inventory.source.getSnapshot()).toMatchObject([{ sessionId: session, tabId: tab.id }])
})

it('allows startup without browser globals or with a key removed during enumeration', () => {
  vi.stubGlobal('localStorage', undefined)
  try { expect(new OpenSidebarTabs().source.getSnapshot()).toEqual([]) }
  finally { vi.unstubAllGlobals() }
  save(session, { [tab.id]: tab })
  vi.spyOn(Storage.prototype, 'getItem').mockReturnValue(null)
  expect(new OpenSidebarTabs().source.getSnapshot()).toEqual([])
})
