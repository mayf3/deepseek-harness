// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { TestRemote, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject, NS, PANEL_ID } from '../src/client/index.ts'
import { PluginManagerPage } from '../src/client/PluginManagerPage.tsx'
import { PluginsPanelIcon } from '../src/client/PluginsPanelIcon.tsx'
import { PresetPluginsSection } from '../src/client/PresetPluginsSection.tsx'
import type { PluginManagerFace } from '../src/client/manager-store.ts'
import { apply as hostApply } from '../src/index.ts'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  class LocaleHolder extends Service {
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'localeHolder')
    }
  }
  new LocaleHolder(ctx)
  const list = vi.fn(() => Promise.resolve({ ok: true as const, value: [] }))
  const inventory = vi.fn(() => Promise.resolve({ ok: true as const, value: { entries: [] } }))
  const remote = new TestRemote(ctx, {
    plugins: { list },
    pluginInventory: { list: inventory },
  })
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, list, inventory, remote }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: {
      'main': { kind: 'keyed', scope: 'root' },
      'sidebar.panellist': { kind: 'list', scope: 'root' },
      'settings.agentPreset.detail': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
}

describe('ui-plugin-manager browser plugin', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares only the services the page and its two Remote faces use', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.plugins', 'remote.pluginInventory'])
  })

  it('registers the sidebar entry and its page, which reads the Host only once rendered and follows Host changes', async () => {
    const b = await bench()
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const entry = b.slots.entries('main')[0]!
    expect(entry.component).toBe(PluginManagerPage)
    expect(entry.options).toMatchObject({ key: PANEL_ID })
    expect(entry.locale).toBe(NS)
    // The sidebar entry addresses the page by the same id and speaks the dictionary.
    const icon = b.slots.entries('sidebar.panellist')[0]!
    expect(icon.component).toBe(PluginsPanelIcon)
    expect(icon.options).toMatchObject({ id: PANEL_ID, order: 0 })
    expect(icon.locale).toBe(NS)
    expect(resolveSlotLabel(icon.options.label)).toBe('插件')
    // The same store feeds the capabilities section of every preset's detail page.
    const section = b.slots.entries('settings.agentPreset.detail')[0]!
    expect(section.component).toBe(PresetPluginsSection)
    expect(section.options).toMatchObject({ id: 'plugins', order: 0 })
    expect(section.locale).toBe(NS)
    const sectionFace = (section.inject as unknown as () => PluginManagerFace)()
    expect(b.list).not.toHaveBeenCalled()

    const face = (entry.inject as unknown as () => PluginManagerFace)()
    expect(sectionFace.hooks.pluginManager).toBe(face.hooks.pluginManager)
    // A Host change before the first render is not a reason to read.
    b.remote.emit('plugins/changed', [{ reason: 'install' }])
    b.ctx.emit('connection/reset')
    await Promise.resolve()
    expect(b.list).not.toHaveBeenCalled()
    face.ensure()
    await vi.waitFor(() => { expect(face.hooks.pluginManager.getSnapshot().status).toBe('ready') })
    expect(b.list).toHaveBeenCalledTimes(1)
    b.remote.emit('plugins/changed', [{ reason: 'enable', packageName: 'x' }])
    await vi.waitFor(() => { expect(b.list).toHaveBeenCalledTimes(2) })
    b.ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(b.list).toHaveBeenCalledTimes(3) })

    // Install output folds into an open run only.
    face.openInstall()
    face.editInstallSpec('pkg')
    b.remote.emit('plugins/install-log', [{ jobId: 'j', argv: ['pnpm', 'add', 'pkg'], cwd: '/p', spec: 'pkg', stream: 'stdout', text: 'early' }])
    expect(face.hooks.pluginManager.getSnapshot().install.runs).toEqual([])

    // Shipped preset names resolve over the agent-preset dictionaries the
    // real plugin registers; user-authored metadata stays untranslated.
    b.locale.register('settings.agentPreset', 'zh', { presetStandardName: '标准模式' } as never)
    expect(face.presetName({ id: 'standard', trust: 'system', isDefault: true, rows: [] })).toBe('标准模式')
    expect(face.presetName({ id: 'mine', trust: 'user', name: '我自己的', isDefault: false, rows: [] })).toBe('我自己的')

    await fiber.dispose()
    expect(b.slots.entries('main')).toHaveLength(0)
    expect(b.slots.entries('sidebar.panellist')).toHaveLength(0)
    expect(b.slots.entries('settings.agentPreset.detail')).toHaveLength(0)
    b.remote.emit('plugins/changed', [{ reason: 'install' }])
    await Promise.resolve()
    expect(b.list).toHaveBeenCalledTimes(3)
  })
})
