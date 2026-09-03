/** What the browser half registers, and that it all leaves with the fiber. */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { RemoteError, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {
  BashCardFace, ConfigurablePluginsTabFace, PluginsSettingsSectionInjected, ScopeSwitcherFace,
} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { SubagentModelSelectionCardController } from '../src/client/subagent-model-selection-card-controller.ts'
import { apply as hostApply } from '../src/index.ts'

// These specs assert the shipped Chinese copy. The lane has no jsdom `window`,
// so browser-language detection never runs and a fresh LocaleRuntime opens on
// FALLBACK_LOCALE (en); bench stages zh explicitly on the locale instead.

/**
 * @param served - namespaces the Host describes; omitted answers a failed read,
 * which is what most of these specs want (no card has anything to render).
 */
async function bench(served?: string[]) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const describeCredentials = vi.fn(() => Promise.resolve({
    ok: false, error: new RemoteError('gateway/internal', 'no provider', {}),
  }))
  const models = vi.fn(() => Promise.resolve({
    ok: true as const, value: { groups: [], failures: [] },
  }))
  const describeSettings = vi.fn((scope?: string) => Promise.resolve(served === undefined
    ? { ok: false, error: new RemoteError('gateway/internal', 'no provider', {}) }
    : {
      ok: true,
      value: {
        writable: true,
        hasDocument: true,
        ...scope === undefined ? { scopes: [] } : { scope, scopes: [scope] },
        namespaces: served.map(ns => ({
          ns, registered: scope === undefined, schema: {}, value: {}, applies: 'live', secrets: [], revision: 0,
          ...scope === undefined ? {} : { scope, inherited: {} },
        })),
      },
    }))
  const listPresets = vi.fn(() => Promise.resolve({
    ok: true as const,
    value: {
      authorable: true,
      presets: [{ id: 'standard', trust: 'system' as const, isDefault: true }],
    },
  }))
  const remote = new TestRemote(ctx, {
    agentPresets: { list: listPresets },
    credentials: { describe: describeCredentials, set: vi.fn() },
    session: { modelCatalog: models },
    settings: { describe: describeSettings },
  })
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  return {
    ctx, slots: ctx.get('slots') as SlotRegistry, describeCredentials, describeSettings, listPresets, models, remote,
  }
}

function declareRoot(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.section': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-settings-plugins apply', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares the services it uses', () => {
    expect(inject).toEqual([
      'slots', 'locale', 'remote', 'remote.agentPresets', 'remote.credentials', 'remote.session', 'settingsScope',
    ])
  })

  it('registers one Plugins section and declares the tab and card slots', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)

    await ctx.plugin({ inject: [...inject], apply }).await()

    const section = slots.entries('settings.section')[0]!
    expect(section.options).toMatchObject({ id: 'plugins', order: 15 })
    // The nav label is a locale-following thunk; owners resolve it at read time.
    expect(resolveSlotLabel(section.options.label)).toBe('插件')
    expect(slots.spec('settings.plugins.tab')).toMatchObject({ kind: 'list', scope: 'root' })
    const tab = slots.entries('settings.plugins.tab')[0]!
    expect(tab.options).toMatchObject({ id: 'configurable', order: 0 })
    expect(resolveSlotLabel(tab.options.label)).toBe('插件配置')
    expect(slots.spec('settings.plugin.item')).toMatchObject({ kind: 'keyed', scope: 'root' })
  })


  it('injects a live tab projection, the card directory, and one business face per card', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()

    const section = slots.entries('settings.section')[0]!
    const sectionFace = (section.inject as unknown as () => PluginsSettingsSectionInjected)()
    const initialTabs = sectionFace.hooks.tabs.getSnapshot()
    expect(initialTabs).toEqual([
      { id: 'configurable', order: 0, label: '插件配置' },
    ])
    expect(sectionFace.hooks.tabs.getSnapshot()).toBe(initialTabs)

    const listener = vi.fn()
    const unsubscribe = sectionFace.hooks.tabs.subscribe(listener)
    slots.register({ name: 'settings.plugins.tab', id: 'plain' } as never, () => null)
    expect(sectionFace.hooks.tabs.getSnapshot()).toEqual([
      { id: 'configurable', order: 0, label: '插件配置' },
      { id: 'plain', order: 0, label: '' },
    ])
    unsubscribe()

    const tab = slots.entries('settings.plugins.tab')[0]!
    const tabFace = (tab.inject as unknown as () => ConfigurablePluginsTabFace)()
    expect(Object.keys(tabFace.hooks)).toEqual(['configurablePlugins', 'scopeSwitcher'])
    for (const entry of slots.entries('settings.plugin.item')) {
      const face = (entry as { inject?: () => unknown }).inject?.() as { hooks: Record<string, unknown> }
      // Each card injects exactly one snapshot store plus its own actions.
      expect(Object.keys(face.hooks)).toHaveLength(1)
    }
  })

  it('keys each card it ships on the settings namespace that card edits', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)

    await ctx.plugin({ inject: [...inject], apply }).await()

    expect(slots.entries('settings.plugin.item').map(entry => entry.options.key))
      .toEqual(['shell', 'agent-loop', 'subagent-model-selection', 'web-search-deepseek', 'skill-filesystem'])
  })

  it('dispatches the served namespaces its cards claim, and no others', async () => {
    // ui-theme is served but belongs to another surface, and a deployment
    // composing no PowerShell/POSIX executor serves no `bash` at all.
    const { ctx, slots } = await bench(['agent-loop', 'ui-theme', 'web-search-deepseek'])
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()

    const tab = slots.entries('settings.plugins.tab')[0]!
    const face = (tab.inject as unknown as () => ConfigurablePluginsTabFace)()
    await vi.waitFor(() => {
      expect(face.hooks.configurablePlugins.getSnapshot().namespaces)
        .toEqual(['agent-loop', 'web-search-deepseek'])
    })
  })

  it('re-reads the served namespaces when the Host commits a settings document', async () => {
    // Which namespaces the Host serves is a registration fact the wire never
    // announces on its own, so the tab rides the invalidation that can
    // accompany a changed composition.
    const { ctx, slots, describeSettings, remote } = await bench(['bash'])
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(describeSettings).toHaveBeenCalled() })
    describeSettings.mockClear()

    remote.emit('settings/document-updated', ['bash', 1])

    await vi.waitFor(() => { expect(describeSettings).toHaveBeenCalled() })
  })

  it('re-reads the served namespaces after a reconnect', async () => {
    const { ctx, slots, describeSettings } = await bench(['bash'])
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(describeSettings).toHaveBeenCalled() })
    describeSettings.mockClear()

    ctx.emit('connection/reset')

    await vi.waitFor(() => { expect(describeSettings).toHaveBeenCalled() })
  })

  it('re-reads the credential when the Host reports the watched reference changed', async () => {
    const { ctx, slots, describeCredentials, remote } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(describeCredentials).toHaveBeenCalled() })
    describeCredentials.mockClear()

    // A key written on another surface changes no settings section, so this
    // event is the only thing that reaches the card.
    remote.emit('credentials/reference-updated', ['DEEPSEEK_API_KEY'])

    await vi.waitFor(() => { expect(describeCredentials).toHaveBeenCalledTimes(1) })
  })

  it('refreshes the subagent catalog after model inputs change or the connection resets', async () => {
    const refresh = vi.spyOn(SubagentModelSelectionCardController.prototype, 'refreshCatalog')
    const reset = vi.spyOn(SubagentModelSelectionCardController.prototype, 'resetConnection')
    const { ctx, slots, remote } = await bench(['subagent-model-selection'])
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    refresh.mockClear()
    reset.mockClear()

    remote.emit('llm/adapters-updated', [])
    expect(refresh).toHaveBeenCalledTimes(1)
    remote.emit('settings/document-updated', ['llm-deepseek', 1])
    expect(refresh).toHaveBeenCalledTimes(2)
    ctx.emit('connection/reset')
    expect(reset).toHaveBeenCalledTimes(1)
  })

  it('ignores a credential change for a reference no card watches', async () => {
    const { ctx, slots, describeCredentials, remote } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(describeCredentials).toHaveBeenCalled() })
    describeCredentials.mockClear()

    remote.emit('credentials/reference-updated', ['SOME_OTHER_KEY'])
    await Promise.resolve()

    expect(describeCredentials).not.toHaveBeenCalled()
  })

  it('lists the roster on first use and switches every card to the selected preset scope', async () => {
    const { ctx, slots, describeSettings, listPresets, remote } = await bench(['shell'])
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const tab = slots.entries('settings.plugins.tab')[0]!
    const face = (tab.inject as unknown as () => ConfigurablePluginsTabFace & ScopeSwitcherFace)()
    expect(listPresets).not.toHaveBeenCalled()
    face.ensureScopes()
    await vi.waitFor(() => {
      expect(face.hooks.scopeSwitcher.getSnapshot()).toMatchObject({
        status: 'ready', presets: [{ id: 'standard', isDefault: true }],
      })
    })
    // Shipped preset names resolve through the agent-preset dictionaries the
    // real plugin registers; user-authored metadata stays as declared.
    ctx.locale.register('settings.agentPreset', 'zh', { presetStandardName: '标准模式' } as never)
    expect(face.presetName({ id: 'standard', trust: 'system', isDefault: true })).toBe('标准模式')
    expect(face.presetName({ id: 'mine', trust: 'user', name: '我自己的', isDefault: false })).toBe('我自己的')

    const bash = slots.entries('settings.plugin.item')[0]!
    const bashFace = (bash.inject as unknown as () => BashCardFace)()
    await vi.waitFor(() => { expect(bashFace.hooks.bashCard.getSnapshot()).toMatchObject({ scope: undefined, registered: true }) })
    describeSettings.mockClear()
    face.selectScope('preset/standard')
    // The scoped mirror is read on first selection, and the card follows it.
    await vi.waitFor(() => { expect(describeSettings).toHaveBeenCalledWith('preset/standard') })
    await vi.waitFor(() => {
      expect(bashFace.hooks.bashCard.getSnapshot()).toMatchObject({ scope: 'preset/standard', registered: false })
    })
    expect(face.hooks.scopeSwitcher.getSnapshot().scope).toBe('preset/standard')
    // A scoped commit reloads the scoped mirror only.
    describeSettings.mockClear()
    remote.emit('settings/document-updated', ['shell', 1, 'preset/standard'])
    await vi.waitFor(() => { expect(describeSettings).toHaveBeenCalledTimes(1) })
    expect(describeSettings).toHaveBeenCalledWith('preset/standard')
    // A reconnect re-reads the roster on the next use.
    ctx.emit('connection/reset')
    expect(face.hooks.scopeSwitcher.getSnapshot().status).toBe('idle')
    face.ensureScopes()
    await vi.waitFor(() => { expect(listPresets).toHaveBeenCalledTimes(2) })
  })

  it('reports a roster the Host refused or a transport that failed without losing the global instance', async () => {
    const { ctx, slots, listPresets } = await bench(['shell'])
    listPresets
      .mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'no roster', {}) } as never)
      .mockRejectedValueOnce(new Error('offline'))
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const tab = slots.entries('settings.plugins.tab')[0]!
    const face = (tab.inject as unknown as () => ScopeSwitcherFace)()
    face.ensureScopes()
    await vi.waitFor(() => { expect(face.hooks.scopeSwitcher.getSnapshot().status).toBe('error') })
    expect(face.hooks.scopeSwitcher.getSnapshot()).toMatchObject({ scope: undefined, presets: [] })
    ctx.emit('connection/reset')
    face.ensureScopes()
    await vi.waitFor(() => { expect(listPresets).toHaveBeenCalledTimes(2) })
    await vi.waitFor(() => { expect(face.hooks.scopeSwitcher.getSnapshot().status).toBe('error') })
  })

  it('registers into a declaration that arrives after apply', async () => {
    const { ctx, slots } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()

    declareRoot(slots)

    await vi.waitFor(() => { expect(slots.entries('settings.section')).toHaveLength(1) })
  })

  it('collapses every contribution on teardown', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(slots.entries('settings.plugin.item')).toHaveLength(5)

    await fiber.dispose()

    expect(slots.entries('settings.section')).toHaveLength(0)
    expect(slots.spec('settings.plugins.tab')).toBeUndefined()
    expect(slots.spec('settings.plugin.item')).toBeUndefined()
  })
})
