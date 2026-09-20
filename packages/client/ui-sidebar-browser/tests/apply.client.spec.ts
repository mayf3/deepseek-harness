/** Browser type, Slot, locale, and HMR disposal through the real registries. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import { BrowserBody } from '../src/client/view/BrowserBody.tsx'
import { BrowserTitle } from '../src/client/view/BrowserTitle.tsx'
import type { BrowserInjected } from '../src/client/browser/BrowserController.ts'
import { BROWSER_ID, BROWSER_KIND } from '../src/client/definition.tsx'
import { apply, inject } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

interface Recorded {
  name: string
  key: string
  locale?: string
  store?: unknown
  inject?: unknown
  component: unknown
}

async function boot() {
  const ctx = new Context()
  contexts.push(ctx)
  const tabs = new SidebarRightTabRegistry(ctx)
  const registered: Recorded[] = []
  const slots = {
    inject: vi.fn((_name: string, register: () => () => void) => register()),
    register: vi.fn((options: Omit<Recorded, 'component'>, component: unknown) => {
      const entry: Recorded = { ...options, component }
      registered.push(entry)
      return () => { registered.splice(registered.indexOf(entry), 1) }
    }),
  }
  const dictionaries = new Map<string, unknown>()
  const locale = {
    bind: vi.fn(() => (key: string) => key),
    register: vi.fn((namespace: string, value: unknown) => {
      dictionaries.set(namespace, value)
      return () => { dictionaries.delete(namespace) }
    }),
  }
  ctx.provide('sidebarRightTabs', tabs as never)
  ctx.provide('sidebarRight', { openTabs: createSnapshotStore([]) } as never)
  ctx.provide('slots', slots as never)
  ctx.provide('locale', locale as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { tabs, registered, dictionaries, fiber }
}

describe('ui-sidebar-browser apply', () => {
  it('registers a multi-instance builtin and its body and title', async () => {
    const { tabs, registered, dictionaries } = await boot()
    const definition = tabs.get(BROWSER_KIND)
    expect(definition).toMatchObject({ id: BROWSER_ID, kind: BROWSER_KIND, multiple: true, priority: 'builtin' })
    expect(definition?.title('sidebar://browser')).toBe('type.label')
    expect(definition?.guide?.map(entry => [entry.order, entry.title(), entry.description?.()]))
      .toEqual([[30, 'guide.title', 'guide.description']])
    expect(dictionaries.get('sidebarBrowser')).toEqual({ zh, en })
    expect(dictionaries.get('sidebarBrowser')).toMatchObject({
      zh: { 'guide.description': '浏览网页' },
      en: { 'guide.description': 'Browse web pages' },
    })
    expect(registered.map(entry => [entry.name, entry.key, entry.locale, entry.component])).toEqual([
      ['sidebar.right.pane.tab', BROWSER_ID, 'sidebarBrowser', BrowserBody],
      ['sidebar.right.pane.tab.title', BROWSER_ID, undefined, BrowserTitle],
    ])
    expect(registered[0]?.store).toBeDefined()
    expect(registered[0]?.inject).toBeTypeOf('function')
    const injectFace = registered[0]?.inject as ((sessionId: string, actions: unknown) => unknown)
    const browser = injectFace('session', { replace: vi.fn(), forget: vi.fn() }) as BrowserInjected
    expect(browser.keyedHooks.browserState('missing')).toBeUndefined()
    expect(typeof browser.mount).toBe('function')
  })

  it('removes every registration when the plugin is disposed', async () => {
    const { tabs, registered, dictionaries, fiber } = await boot()
    await fiber.dispose()
    expect(tabs.get(BROWSER_KIND)).toBeUndefined()
    expect(registered).toEqual([])
    expect(dictionaries.size).toBe(0)
  })
})
