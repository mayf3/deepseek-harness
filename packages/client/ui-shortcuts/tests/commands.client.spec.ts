// @vitest-environment jsdom
import { describe, expect, onTestFinished } from 'vitest'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import type {} from '@deepseek-ai/dsh-client-shortcuts/client'
import type { createSettingsShellStore } from '../../ui-settings-general/src/client/shell-store.ts'
import type { createLayoutStore } from '../../ui-layout/src/client/stores.ts'
import type { ReferenceInjected } from '../src/client/Reference.tsx'
import type { createShortcutsStore } from '../src/client/store.ts'

const it = createClientTest({ roster: webApp })
const gesture = { code: 'Comma', control: false, alt: false, shift: false, meta: true, repeat: false,
  composing: false, defaultPrevented: false }
const context = { region: 'page', modal: null, target: null } as const

describe('assembled shortcut command owners', () => {
  it('keeps desktop defaults out of Web and removes commands on owner unload', async ({ start }) => {
    const client = await start()
    const shortcuts = client.ctx.shortcuts
    const overlay = client.ctx.slots.entries('shell.overlay').find(entry => entry.options.id === 'shortcuts')!
    const injected = (overlay.inject as unknown as () => ReferenceInjected)()
    expect(injected.hooks.catalog).toBe(shortcuts.catalog)
    await shortcuts.reload()
    expect(injected.describeBinding(null).keys).toEqual([])
    await injected.recording(false)
    const shortcut = shortcuts.catalog.getSnapshot().find(row => row.id === 'shortcuts.open')!
    expect((await injected.edit({ type: 'reset', id: shortcut.id }, shortcuts.config.getSnapshot().revision)).status).toBe('saved')
    const row = client.ctx.slots.entries('settings.general.item').find(entry => entry.options.id === 'shortcuts')!
    expect((row.inject as unknown as () => ReferenceInjected)().hooks.catalog).toBe(shortcuts.catalog)
    const ownerIds = ['settings.open', 'shortcuts.open', 'sidebar.left.toggle']
    const ownedRows = () => shortcuts.catalog.getSnapshot().filter(row => ownerIds.includes(row.id))
    expect(ownedRows().map(row => row.id).sort()).toEqual(ownerIds)
    expect(ownedRows().filter(row => row.keys.length > 0).map(row => row.id)).toEqual(['shortcuts.open'])
    for (const owner of ['ui-shortcuts', 'ui-settings-general', 'ui-layout']) await client.unload(`@deepseek-ai/dsh-client-${owner}`)
    expect(ownedRows()).toEqual([])
    expect(shortcuts.fixedCatalog.getSnapshot().some(row => row.id.startsWith('fixed.'))).toBe(false)
  }, 60_000)

  it('shares the settings/reference stores and gives desktop bindings priority over modals without repeating actions', async ({ start }) => {
    const previous = document.documentElement.dataset.platform
    document.documentElement.dataset.platform = 'darwin'
    onTestFinished(() => {
      if (previous === undefined) delete document.documentElement.dataset.platform
      else document.documentElement.dataset.platform = previous
    })
    const client = await start()
    const shortcuts = client.ctx.shortcuts
    const settings = (client.ctx.slots.entries('sidebar.settings')[0]!.store as ReturnType<typeof createSettingsShellStore>).create()
    const reference = (client.ctx.slots.entries('shell.overlay').find(entry => entry.options.id === 'shortcuts')!.store as ReturnType<typeof createShortcutsStore>).create()
    const layout = (client.ctx.slots.entries('root')[0]!.store as ReturnType<typeof createLayoutStore>).create()
    expect(shortcuts.dispatch(gesture, context, () => {}).status).toBe('handled')
    expect(settings.getSnapshot().open).toBe(true)
    const opened = settings.getSnapshot()
    shortcuts.dispatch(gesture, { ...context, modal: 'settings' }, () => {})
    expect(settings.getSnapshot()).toBe(opened)
    shortcuts.dispatch({ ...gesture, code: 'Slash' }, { ...context, modal: 'settings' }, () => {})
    expect(reference.getSnapshot().open).toBe(true)
    const sidebar = layout.getSnapshot().layoutInfo.sidebar
    expect(shortcuts.dispatch({ ...gesture, code: 'KeyB' }, { ...context, modal: 'shortcuts' }, () => {}).status).toBe('handled')
    expect(layout.getSnapshot().layoutInfo.sidebar).not.toBe(sidebar)
    shortcuts.dispatch({ ...gesture, code: 'KeyB' }, context, () => {})
    expect(layout.getSnapshot().layoutInfo.sidebar).toBe(sidebar)
    shortcuts.dispatch({ ...gesture, code: 'KeyB', repeat: true }, context, () => {})
    expect(layout.getSnapshot().layoutInfo.sidebar).toBe(sidebar)
  })
})
