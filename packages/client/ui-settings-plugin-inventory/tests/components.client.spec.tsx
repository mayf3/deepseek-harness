// @vitest-environment jsdom
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ClientEntryState } from '@deepseek-ai/dsh-client-modules/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginInventorySettingsTab } from '../src/client/PluginInventorySettingsTab.tsx'
import type {
  PluginInventorySettingsTabInjected,
  PluginInventorySettingsTabProps,
} from '../src/client/PluginInventorySettingsTab.tsx'
import { en, zh, type PluginInventoryLocaleKey } from '../src/client/locales.ts'
import { BundleManager, usePluginManagement, type PluginManagement } from '../src/client/management.tsx'

afterEach(cleanup)

type Snapshot = Awaited<ReturnType<PluginInventorySettingsTabInjected['list']>>
const t = ((key: PluginInventoryLocaleKey, params?: Record<string, string>): string =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, value),
    en[key],
  )) as PluginInventorySettingsTabProps['t']

function props(
  list: PluginInventorySettingsTabInjected['list'],
  presetName: PluginInventorySettingsTabInjected['presetName'] = preset => preset.name ?? preset.id,
): PluginInventorySettingsTabProps {
  return {
    t,
    list,
    presetName,
    useClientSync: bindSnapshotSelector(createSnapshotStore<ClientEntryState>({ syncing: false, failures: [] })),
    retryClient: vi.fn(),
  } as PluginInventorySettingsTabProps
}

/** A deployment with a roster: one failed global row, two preset-provided rows. */
const SNAPSHOT = {
  entries: [
    { entryId: 'telemetry', moduleName: '@fixture/telemetry', enabled: true, fiberPhase: 'failed' },
    { entryId: 'timer', moduleName: 'cordis:timer', enabled: true, fiberPhase: 'active' },
    { entryId: '8a1b2c3d', moduleName: '@deepseek-ai/dsh-hmr', enabled: true, fiberPhase: 'active' },
    { entryId: 'unobserved', moduleName: '@fixture/unobserved-name', enabled: true, fiberPhase: null },
    { entryId: 'bash-host', moduleName: '@deepseek-ai/dsh-tool-bash', enabled: false, fiberPhase: null },
    { entryId: 'fs-host', moduleName: '@deepseek-ai/dsh-tool-fs', enabled: false, fiberPhase: null },
    { entryId: 'dormant', moduleName: '@fixture/dormant', enabled: false, fiberPhase: null },
  ],
  agentPresets: [
    {
      id: 'standard',
      trust: 'system',
      name: '标准模式',
      isDefault: true,
      rows: [
        { entryId: 'bash', moduleName: '@deepseek-ai/dsh-tool-bash', enabled: true, fiberPhase: 'active' },
        { entryId: 'fs', moduleName: '@deepseek-ai/dsh-tool-fs', enabled: true, fiberPhase: null },
        {
          entryId: 'pwsh',
          moduleName: '@fixture/pwsh',
          enabled: 'conditional',
          condition: 'process.platform === \'win32\'',
          fiberPhase: null,
        },
        { entryId: 'codex', moduleName: '@fixture/codex', enabled: false, fiberPhase: null },
        { entryId: 'crashy', moduleName: '@fixture/crashy', enabled: true, fiberPhase: 'failed' },
        { entryId: null, moduleName: '@fixture/anonymous', enabled: true, fiberPhase: null },
      ],
    },
    {
      id: 'ptc',
      trust: 'system',
      isDefault: false,
      rows: [
        { entryId: 'bash', moduleName: '@deepseek-ai/dsh-tool-bash', enabled: true, fiberPhase: null },
        { entryId: 'bash-fork', moduleName: '@deepseek-ai/dsh-tool-bash', enabled: true, fiberPhase: null },
        { entryId: 'fs', moduleName: '@deepseek-ai/dsh-tool-fs', enabled: 'conditional', fiberPhase: null },
      ],
    },
    { id: 'shattered', trust: 'user', name: '坏预设', isDefault: false, broken: 'the composition file is missing', rows: [] },
  ],
} as unknown as Snapshot

async function renderReady(snapshot: Snapshot = SNAPSHOT): Promise<ReturnType<typeof render>> {
  const view = render(<PluginInventorySettingsTab {...props(async () => snapshot)} />)
  await screen.findByRole('searchbox', { name: en.search })
  return view
}

const globalToggle = (): HTMLElement =>
  screen.getByRole('button', { name: (name: string) => name.startsWith(en.globalTitle) })

describe('PluginInventorySettingsTab', () => {
  it('shows the default preset first and keeps the global plane collapsed', async () => {
    const view = await renderReady()

    const switcher = screen.getByRole('button', { name: en.switcherLabel })
    expect(switcher.textContent).toBe('标准模式 (default)')
    fireEvent.click(switcher)
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      '标准模式 (default)',
      'ptc',
      '坏预设 (failed to load)',
    ])
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0)
    expect(screen.getByText(en.presetSubtitle)).toBeTruthy()
    expect(view.container.querySelector('[data-preset-plugin-count]')?.getAttribute('data-preset-plugin-count')).toBe('6')

    // Only the preset group lists rows while the global plane stays collapsed.
    expect(screen.getAllByRole('listitem')).toHaveLength(6)
    expect(screen.getAllByText(en.enabledTag)).toHaveLength(3)
    expect(screen.getByText(en.conditionalTag)).toBeTruthy()
    expect(screen.getByText(en.disabledTag)).toBeTruthy()
    expect(screen.getByText(en.failedTag)).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Running' })).toBeTruthy()
    // No live fiber, no dot: file-state rows carry only their enablement tag.
    expect(screen.queryByRole('img', { name: 'Not running' })).toBeNull()

    expect(globalToggle().getAttribute('aria-expanded')).toBe('false')
    expect(view.container.querySelector('[data-plugin-count]')?.getAttribute('data-plugin-count')).toBe('7')
    expect(screen.getByText(`1 ${en.failedCountLabel}`)).toBeTruthy()

    // A preset row expands into its source facts.
    fireEvent.click(screen.getByRole('button', { name: 'pwsh, pwsh, Conditional' }))
    expect(screen.getByText(en.fromPreset)).toBeTruthy()
    expect(screen.getByText('标准模式')).toBeTruthy()
    expect(screen.getByText(en.condition)).toBeTruthy()
    expect(screen.getByText('process.platform === \'win32\'')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'pwsh, pwsh, Conditional' }))
    expect(screen.queryByText(en.condition)).toBeNull()

    // A failed preset row names its runtime state instead of a condition.
    fireEvent.click(screen.getByRole('button', { name: 'crashy, crashy, Failed' }))
    expect(screen.getByText(en.runtime)).toBeTruthy()
    expect(screen.getByText('Failed to start')).toBeTruthy()

    // A row declaring no id has no Loader identity line, only its module.
    fireEvent.click(screen.getByRole('button', { name: 'anonymous, Enabled' }))
    expect(view.container.querySelector('[data-loader-entry]')).toBeNull()
    expect(screen.getByText(en.moduleLabel).nextElementSibling?.textContent).toBe('@fixture/anonymous')
  })

  it('distinguishes collapsed same-module rows by stable entry id', async () => {
    const longId = 'include:agent-presets:tool-subagent-secondary-with-a-complete-stable-identity'
    const subtitle = 'agent-presets:tool-subagent-secondary-with-a-complete-stable-identity'
    await renderReady({
      entries: [],
      agentPresets: [{
        id: 'same-module',
        trust: 'user',
        isDefault: true,
        rows: [
          { entryId: 'tool-subagent-primary', moduleName: '@deepseek-ai/dsh-tool-subagent', enabled: true, fiberPhase: null },
          { entryId: longId, moduleName: '@deepseek-ai/dsh-tool-subagent', enabled: false, fiberPhase: null },
        ],
      }],
    })

    expect(screen.getByRole('button', { name: 'tool-subagent, tool-subagent-primary, Enabled' })
      .getAttribute('aria-expanded')).toBe('false')
    const secondary = screen.getByRole('button', { name: `tool-subagent, ${longId}, Disabled` })
    expect(secondary.getAttribute('aria-expanded')).toBe('false')
    expect(secondary.children).toHaveLength(2)
    expect(secondary.children[0]?.textContent).toContain('tool-subagent')
    expect(secondary.children[0]?.textContent).toContain('Disabled')
    expect(secondary.children[1]?.textContent).toBe(subtitle)
    expect(screen.getByTitle(longId).textContent).toBe(subtitle)

    fireEvent.change(screen.getByRole('searchbox', { name: en.search }), { target: { value: 'include:agent-presets:tool-subagent-secondary' } })
    expect(screen.queryByRole('button', { name: 'tool-subagent, tool-subagent-primary, Enabled' })).toBeNull()
    const filteredSecondary = screen.getByRole('button', { name: `tool-subagent, ${longId}, Disabled` })
    fireEvent.click(filteredSecondary)
    expect(filteredSecondary.getAttribute('aria-expanded')).toBe('true')
  })

  it('expands the global plane with failures first and preset-provided rows inline', async () => {
    const view = await renderReady()

    expect(screen.queryByText(en.presetEnabledTag)).toBeNull()
    fireEvent.click(globalToggle())
    expect(globalToggle().getAttribute('aria-expanded')).toBe('true')
    const failed = view.container.querySelector('[data-plugin-scope="global"] [data-failed="true"]')
    expect(failed?.getAttribute('data-plugin-entry')).toBe('telemetry')
    // Failures float above the Loader-ordered remainder.
    expect(view.container.querySelector('[data-plugin-scope="global"] li')).toBe(failed)

    // Rows the presets took over sit inline, marked instead of plainly disabled.
    expect(screen.getAllByText(en.presetEnabledTag)).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: 'tool-bash, bash-host, Enabled via presets' }))
    expect(screen.getByText(en.presetProvidedDetail)).toBeTruthy()
    expect(screen.getByText(en.enabledIn)).toBeTruthy()
    expect(screen.getByText('标准模式 · ptc')).toBeTruthy()

    // The failed global card reports its runtime state.
    fireEvent.click(screen.getByRole('button', { name: 'telemetry, telemetry, Failed' }))
    expect(screen.getByText('Failed to start')).toBeTruthy()

    // An enabled entry with no live fiber says so in its details, dot-free.
    fireEvent.click(screen.getByRole('button', { name: 'unobserved-name, unobserved, Enabled' }))
    expect(screen.getByText('Not running')).toBeTruthy()

    // A disabled row outside every preset stays plainly disabled.
    fireEvent.click(screen.getByRole('button', { name: 'dormant, dormant, Disabled' }))
    expect(screen.queryByText(en.presetProvidedDetail)).toBeNull()

    fireEvent.click(globalToggle())
    expect(globalToggle().getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText(en.presetEnabledTag)).toBeNull()
  })

  it('switches the inspected preset in place, including broken ones', async () => {
    const view = await renderReady()
    const pickPreset = (label: string): void => {
      fireEvent.click(screen.getByRole('button', { name: en.switcherLabel }))
      fireEvent.click(screen.getByRole('menuitem', { name: label }))
    }

    pickPreset('ptc')
    expect(view.container.querySelector('[data-preset-plugin-count]')?.getAttribute('data-preset-plugin-count')).toBe('3')
    fireEvent.click(screen.getByRole('button', { name: 'tool-bash, bash, Enabled' }))
    // An unnamed preset labels its source by id.
    expect(screen.getByText(en.fromPreset).nextElementSibling?.textContent).toBe('ptc')

    pickPreset('坏预设 (failed to load)')
    expect(screen.getByRole('alert').textContent).toBe('the composition file is missing')
    expect(view.container.querySelector('[data-preset-plugin-count]')?.getAttribute('data-preset-plugin-count')).toBe('0')
  })

  it('collapses the preset group until a search forces it open', async () => {
    const view = await renderReady()
    const toggle = screen.getByRole('button', { name: en.presetTitle })

    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    // The header keeps its count while the rows are folded away.
    expect(view.container.querySelector('[data-preset-plugin-count]')?.getAttribute('data-preset-plugin-count')).toBe('6')
    expect(view.container.querySelectorAll('[data-plugin-scope="preset"] li')).toHaveLength(0)

    fireEvent.change(screen.getByRole('searchbox', { name: en.search }), { target: { value: 'pwsh' } })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(en.conditionalTag)).toBeTruthy()

    fireEvent.change(screen.getByRole('searchbox', { name: en.search }), { target: { value: '' } })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })

  it('routes every preset name through the display resolver', async () => {
    // The resolver stands in for presetDisplayText: shipped presets localize,
    // user-authored ones keep their own metadata.
    const localized: PluginInventorySettingsTabInjected['presetName'] = preset =>
      preset.trust === 'system' ? `Localized ${preset.id}` : preset.name ?? preset.id
    render(<PluginInventorySettingsTab {...props(async () => SNAPSHOT, localized)} />)
    await screen.findByRole('searchbox', { name: en.search })

    const switcher = screen.getByRole('button', { name: en.switcherLabel })
    expect(switcher.textContent).toBe('Localized standard (default)')
    fireEvent.click(switcher)
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      'Localized standard (default)',
      'Localized ptc',
      '坏预设 (failed to load)',
    ])
    fireEvent.keyDown(document, { key: 'Escape' })

    fireEvent.click(screen.getByRole('button', { name: 'pwsh, pwsh, Conditional' }))
    expect(screen.getByText(en.fromPreset).nextElementSibling?.textContent).toBe('Localized standard')

    fireEvent.click(globalToggle())
    fireEvent.click(screen.getByRole('button', { name: 'tool-bash, bash-host, Enabled via presets' }))
    expect(screen.getByText('Localized standard · Localized ptc')).toBeTruthy()
  })

  it('jumps from a preset-provided row to the preset that enables it', async () => {
    await renderReady()
    fireEvent.click(screen.getByRole('button', { name: en.switcherLabel }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'ptc' }))

    fireEvent.click(globalToggle())
    fireEvent.click(screen.getByRole('button', { name: 'tool-bash, bash-host, Enabled via presets' }))
    fireEvent.click(screen.getByRole('button', { name: en.viewInPreset }))
    expect(screen.getByRole('button', { name: en.switcherLabel }).textContent)
      .toBe('标准模式 (default)')
  })

  it('searches across scopes and points at matches in other presets', async () => {
    const view = await renderReady()
    const search = screen.getByRole('searchbox', { name: en.search })

    fireEvent.change(search, { target: { value: 'tool-bash' } })
    // Searching forces the collapsed global plane and drawer open.
    expect(view.container.querySelector('[data-preset-plugin-count]')?.getAttribute('data-preset-plugin-count')).toBe('1')
    expect(view.container.querySelector('[data-plugin-count]')?.getAttribute('data-plugin-count')).toBe('1')
    expect(screen.getByText(en.presetEnabledTag)).toBeTruthy()
    expect(screen.queryByText(`1 ${en.failedCountLabel}`)).toBeNull()
    const hint = screen.getByText((text: string) => text.startsWith('2 more matches'))
    expect(hint).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'ptc' }))
    expect(screen.getByRole('button', { name: en.switcherLabel }).textContent).toBe('ptc')

    // A match visible only in another preset keeps the pointer without rows.
    fireEvent.change(search, { target: { value: 'crashy' } })
    expect(view.container.querySelector('[data-preset-plugin-count]')?.getAttribute('data-preset-plugin-count')).toBe('0')
    expect(screen.getByText((text: string) => text.startsWith('1 more matches'))).toBeTruthy()
    expect(screen.queryByText(en.emptySearch)).toBeNull()

    // A match on a Loader entry id only reaches the global plane.
    fireEvent.change(search, { target: { value: '8a1b2c3d' } })
    expect(view.container.querySelector('[data-plugin-count]')?.getAttribute('data-plugin-count')).toBe('1')
    expect(screen.queryByText((text: string) => text.includes('more matches'))).toBeNull()

    fireEvent.change(search, { target: { value: 'not-a-plugin' } })
    expect(screen.getByText(en.emptySearch)).toBeTruthy()
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
  })

  it('renders a rosterless deployment as one expanded global list', async () => {
    const view = await renderReady({
      entries: [
        { entryId: 'hmr', moduleName: '@deepseek-ai/dsh-hmr', enabled: true, fiberPhase: 'active' },
        { entryId: 'off', moduleName: '@fixture/off', enabled: false, fiberPhase: null },
      ],
    } as unknown as Snapshot)

    expect(screen.queryByRole('button', { name: en.switcherLabel })).toBeNull()
    expect(globalToggle().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getAllByRole('listitem')).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: 'hmr, hmr, Enabled' }))
    expect(screen.getByText(en.runtime)).toBeTruthy()
    expect(view.container.querySelector('[data-loader-entry]')?.textContent).toBe('hmr')
    fireEvent.click(screen.getByRole('button', { name: 'off, off, Disabled' }))
    expect(screen.getAllByText(en.moduleLabel).length).toBeGreaterThan(0)
    expect(screen.queryByText(en.runtime)).toBeNull()
  })

  it('renders a preset-only snapshot without the global section', async () => {
    await renderReady({
      entries: [],
      agentPresets: [{
        id: 'solo',
        trust: 'user',
        isDefault: false,
        rows: [{ entryId: 'one', moduleName: '@fixture/one', enabled: true, fiberPhase: null }],
      }],
    })

    expect(screen.queryByRole('button', { name: (name: string) => name.startsWith(en.globalTitle) })).toBeNull()
    expect(screen.queryByText(en.empty)).toBeNull()
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
  })

  it('shows a generic failure and retries into the empty state', async () => {
    const list = vi.fn<PluginInventorySettingsTabInjected['list']>()
      .mockRejectedValueOnce(new Error('private transport detail'))
      .mockResolvedValueOnce({ entries: [] })
    render(<PluginInventorySettingsTab {...props(list)} />)

    expect((await screen.findByRole('alert')).textContent).toBe(en.error)
    expect(screen.queryByText('private transport detail')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await waitFor(() => { expect(list).toHaveBeenCalledTimes(2) })
    expect(await screen.findByText(en.empty)).toBeTruthy()
  })

  it('contains a synchronous Remote failure and ignores a result after unmount', async () => {
    const syncFailure = vi.fn(() => { throw new Error('namespace unavailable') }) as PluginInventorySettingsTabInjected['list']
    const failed = render(<PluginInventorySettingsTab {...props(syncFailure)} />)
    expect((await screen.findByRole('alert')).textContent).toBe(en.error)
    failed.unmount()

    const deferred = Promise.withResolvers<Snapshot>()
    const pending = render(<PluginInventorySettingsTab {...props(() => deferred.promise)} />)
    expect(screen.getByText(en.loading)).toBeTruthy()
    pending.unmount()
    await act(async () => { deferred.resolve(SNAPSHOT) })

    const deferredFailure = Promise.withResolvers<Snapshot>()
    const pendingFailure = render(<PluginInventorySettingsTab {...props(() => deferredFailure.promise)} />)
    pendingFailure.unmount()
    await act(async () => { deferredFailure.reject(new Error('late failure')) })
  })
})

describe('persistent profile management', () => {
  it('runs bundle and plugin controls through the same manager and shows failed results', async () => {
    let enabled = true
    let selected = true
    let installed = true
    const list: PluginInventorySettingsTabInjected['list'] = async () => ({
      managementAvailable: true,
      entries: [{ entryId: 'managed' as Snapshot['entries'][number]['entryId'], moduleName: '@fixture/managed', enabled, fiberPhase: enabled ? 'active' : null }],
    })
    const management = {
      listPlugins: async () => [{ ...(await list()).entries[0]!, patchId: 'managed' }],
      listBundles: async () => installed ? [{ name: 'extra', version: '1', enabled: selected, removable: true }] : [],
      setPluginEnabled: vi.fn(async (_id: Snapshot['entries'][number]['entryId'], next: boolean) => {
        enabled = next
        return { changed: true, application: 'applied' as const, stage: 'enable' as const, target: 'managed', enabled: next }
      }),
      setBundleEnabled: vi.fn(async (_name: string, next: boolean) => {
        selected = next
        return { changed: true, application: 'applied' as const, stage: 'enable' as const, target: 'extra', enabled: next }
      }),
      installBundle: vi.fn(async () => ({ changed: false, application: 'failed' as const, stage: 'install' as const, target: 'new-bundle', error: { code: 'operation-error' as const, diagnostic: 'Registry unavailable.' } })),
      removeBundle: vi.fn(async () => {
        installed = false
        return { changed: true, application: 'applied' as const, stage: 'remove' as const, target: 'extra' }
      }),
    } satisfies NonNullable<PluginInventorySettingsTabInjected['management']>
    render(<PluginInventorySettingsTab {...props(list)} management={management} />)
    fireEvent.click(await screen.findByRole('switch', { name: 'Toggle bundle extra' }))
    await waitFor(() => { expect(management.setBundleEnabled).toHaveBeenCalledWith('extra', false) })
    await waitFor(() => { expect(screen.getByRole<HTMLInputElement>('switch', { name: 'Toggle bundle extra' }).checked).toBe(false) })
    fireEvent.click(screen.getByRole('button', { name: /managed, managed/ }))
    fireEvent.click(await screen.findByRole('switch', { name: 'Toggle plugin managed' }))
    await waitFor(() => { expect(management.setPluginEnabled).toHaveBeenCalledWith('managed', false) })
    await waitFor(() => { expect(screen.getByRole<HTMLInputElement>('switch', { name: 'Toggle plugin managed' }).checked).toBe(false) })
    fireEvent.change(screen.getByRole('textbox', { name: 'npm package name or local path' }), { target: { value: 'new-bundle' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable after installation' }))
    fireEvent.click(screen.getByRole('button', { name: 'Install' }))
    await waitFor(() => { expect(management.installBundle).toHaveBeenCalledWith('new-bundle', { enabled: false }) })
    expect((await screen.findByRole('alert')).textContent).toContain('Registry unavailable.')
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => { expect(management.removeBundle).toHaveBeenCalledWith('extra') })
    await waitFor(() => { expect(screen.queryByRole('switch', { name: 'Toggle bundle extra' })).toBeNull() })
  })
})

function managementFixture() {
  const applied = { changed: true, application: 'applied' as const, stage: 'enable' as const, target: 'example' }
  return {
    listPlugins: vi.fn<PluginManagement['listPlugins']>(async () => []),
    listBundles: vi.fn<PluginManagement['listBundles']>(async () => []),
    setPluginEnabled: vi.fn(async () => applied), setBundleEnabled: vi.fn(async () => applied),
    installBundle: vi.fn(async () => applied), removeBundle: vi.fn(async () => applied),
  }
}

it('requires a click to approve the displayed packages and retries the original install options', async () => {
  const manager = managementFixture()
  const result = { changed: false, application: 'failed' as const, stage: 'install' as const,
    target: 'addon@1', enabled: false, pendingBuilds: ['native', '@scope/helper'] }
  function Form() {
    const state = usePluginManagement(manager, true, 0)
    return <BundleManager manager={manager} t={t} state={{ ...state, result: state.result ?? result }} />
  }
  render(<Form />)
  expect(screen.getByText('native')).toBeDefined()
  expect(screen.getByText('@scope/helper')).toBeDefined()
  expect(manager.installBundle).not.toHaveBeenCalled()
  fireEvent.change(screen.getByRole('textbox', { name: en.packageSpec }), { target: { value: 'unrelated' } })
  fireEvent.click(screen.getByRole('button', { name: en.approveBuildsAndRetry }))
  await waitFor(() => { expect(manager.installBundle).toHaveBeenCalledWith('addon@1', { enabled: false, approvedBuilds: ['native', '@scope/helper'] }) })
  await waitFor(() => { expect(screen.queryByRole('group', { name: en.buildApproval })).toBeNull() })
})

it('ignores inventory completion after unmount and reports current read failures', async () => {
  for (const failure of [undefined, new Error('late failure')]) {
    const read = Promise.withResolvers<Awaited<ReturnType<PluginManagement['listBundles']>>>()
    const manager = managementFixture()
    vi.mocked(manager.listBundles).mockReturnValue(read.promise)
    const hook = renderHook(() => usePluginManagement(manager, true, 0))
    hook.unmount()
    await act(async () => {
      if (failure === undefined) read.resolve([])
      else read.reject(failure)
      await read.promise.catch(() => {})
    })
  }
  for (const failure of [new Error('inventory unavailable'), 'inventory rejected']) {
    const manager = managementFixture()
    vi.mocked(manager.listBundles).mockRejectedValue(failure)
    const hook = renderHook(() => usePluginManagement(manager, true, 0))
    await waitFor(() => { expect(hook.result.current.error).toBe(failure instanceof Error ? failure.message : failure) })
    hook.unmount()
  }
})

it('blocks duplicate submissions and refreshes after a rejected management request', async () => {
  const manager = managementFixture()
  const hook = renderHook(() => usePluginManagement(manager, true, 0))
  const pending = Promise.withResolvers<Awaited<ReturnType<PluginManagement['removeBundle']>>>()
  const operation = vi.fn(() => pending.promise)
  await act(async () => {
    const first = hook.result.current.run(operation)
    await hook.result.current.run(operation)
    pending.resolve({ changed: true, application: 'applied', stage: 'remove', target: 'removed' })
    await first
  })
  expect(operation).toHaveBeenCalledOnce()
  expect(hook.result.current.result?.target).toBe('removed')
  for (const failure of [new Error('request unavailable'), 'request rejected']) {
    await act(async () => { await hook.result.current.run(async () => { throw failure }) })
    expect(hook.result.current.error).toBe(failure instanceof Error ? failure.message : failure)
    expect(hook.result.current.busy).toBe(false)
  }
})

it('shows package diagnostics, read errors and protected or missing bundles', () => {
  const manager = managementFixture()
  const state: ReturnType<typeof usePluginManagement> = {
    plugins: [], bundles: [
      { name: 'missing', enabled: false, removable: true, error: { code: 'operation-error', diagnostic: 'package files missing' } },
      { name: 'core', enabled: true, removable: false, readOnlyReason: 'management-required' },
    ], busy: false, refresh: 0, error: 'inventory unavailable', run: async () => {},
    result: { changed: true, application: 'failed', stage: 'install', target: 'example', error: { code: 'not-bundle' },
      packageResult: { exitCode: 1, output: 'failed', truncated: false, logPath: '/profile/operation/pnpm.log' } },
  }
  render(<BundleManager manager={manager} state={state} t={t} />)
  expect(screen.getByText('inventory unavailable')).toBeDefined()
  expect(screen.getByText('/profile/operation/pnpm.log')).toBeDefined()
  expect(screen.getByText(/package files missing/)).toBeDefined()
  expect(screen.getByText(en['management-required'])).toBeDefined()
  expect(screen.getByRole<HTMLInputElement>('switch', { name: 'Toggle bundle missing' }).disabled).toBe(true)
  expect(screen.getByRole<HTMLInputElement>('switch', { name: 'Toggle bundle core' }).disabled).toBe(true)
})

it.each([['en', en], ['zh', zh]] as const)('renders management codes and cleanup results using the %s dictionary', (_locale, dictionary) => {
  const translate = ((key: PluginInventoryLocaleKey) => dictionary[key]) as PluginInventorySettingsTabProps['t']
  render(<BundleManager manager={managementFixture()} t={translate} state={{
    plugins: [], bundles: [{ name: 'plain', enabled: false, removable: true, error: { code: 'not-bundle' } }],
    busy: false, refresh: 0, run: async () => {}, error: undefined,
    result: { changed: true, application: 'failed', stage: 'install', target: 'plain',
      error: { code: 'not-bundle' }, warnings: ['pending external service'], remainingDependencies: ['plain'],
      cleanup: { name: 'plain', error: { code: 'operation-error', diagnostic: 'EACCES' },
        packageResult: { exitCode: 1, output: 'EACCES', truncated: false, logPath: '/cleanup.log' } } },
  }} />)
  expect(screen.getAllByText(dictionary['not-bundle'], { exact: false }).length).toBeGreaterThan(0)
  expect(screen.getByText(dictionary.cleanup, { exact: false })).toBeDefined()
  expect(screen.getByText('/cleanup.log')).toBeDefined()
  expect(screen.getByRole<HTMLInputElement>('switch').disabled).toBe(true)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: dictionary.remove }).disabled).toBe(false)
})

it('localizes protected plugin explanations in expanded details', async () => {
  const list: PluginInventorySettingsTabInjected['list'] = async () => ({ managementAvailable: true,
    entries: [{ entryId: 'managed' as Snapshot['entries'][number]['entryId'], moduleName: '@fixture/managed', enabled: true, fiberPhase: 'active' }],
  })
  const manager = managementFixture()
  manager.listPlugins.mockResolvedValue([{ ...(await list()).entries[0]!, readOnlyReason: 'management-required' }])
  render(<PluginInventorySettingsTab {...props(list)} management={manager} />)
  fireEvent.click(await screen.findByRole('button', { name: /managed, managed/ }))
  expect(await screen.findByText(en['management-required'])).toBeDefined()
})

it('shows a completed dependency cleanup without a subprocess log', () => {
  render(<BundleManager manager={managementFixture()} t={t} state={{
    plugins: [], bundles: [], busy: false, refresh: 0, error: undefined, run: async () => {},
    result: { stage: 'install', target: 'plain', changed: false, application: 'failed', cleanup: { name: 'plain' } },
  }} />)
  expect(screen.getByRole('alert').textContent).toContain('New dependency cleanup: plain — Applied')
})

it('shows current-page sync errors and retries without re-reading Host inventory', async () => {
  const list = vi.fn(async () => ({ entries: [] }))
  const sync = createSnapshotStore<ClientEntryState>({ syncing: true, failures: [] })
  const retryClient = vi.fn()
  render(<PluginInventorySettingsTab {...props(list)} useClientSync={bindSnapshotSelector(sync)} retryClient={retryClient} />)
  expect(screen.getByRole('status').textContent).toContain('Syncing plugins on this page')
  await waitFor(() => { expect(list).toHaveBeenCalledOnce() })
  act(() => { sync.set({ syncing: false, failures: [{ id: 'client-addon', message: 'download failed' }] }) })
  expect(screen.getByText('client-addon: download failed')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Retry this page' }))
  expect(retryClient).toHaveBeenCalledOnce()
  expect(list).toHaveBeenCalledOnce()
  act(() => { sync.set({ syncing: false, failures: [] }) })
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each([en, zh])('renders stale build approval in the selected locale', (dictionary) => {
  const localized = ((key: PluginInventoryLocaleKey) => dictionary[key]) as PluginInventorySettingsTabProps['t']
  render(<BundleManager manager={managementFixture()} t={localized} state={{
    plugins: [], bundles: [], busy: false, refresh: 0, error: undefined, run: async () => {},
    result: { stage: 'install', target: 'addon', changed: false, application: 'failed', error: { code: 'stale-approval' } },
  }} />)
  expect(screen.getByRole('alert').textContent).toContain(dictionary['stale-approval'])
})
