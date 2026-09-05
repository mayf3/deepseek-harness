// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginPackageView } from '@deepseek-ai/dsh-api-remotes/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { PluginManagerSettingsTab } from '../src/client/PluginManagerSettingsTab.tsx'
import type { PluginManagerSettingsTabProps } from '../src/client/PluginManagerSettingsTab.tsx'
import { rowKey, type InstallState, type PluginManagerState, type PresetGroup } from '../src/client/manager-store.ts'
import { en, zh, type PluginManagerLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

const t = ((key: PluginManagerLocaleKey, params?: Record<string, string>): string =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, value),
    en[key],
  )) as PluginManagerSettingsTabProps['t']

function pkg(overrides: Partial<PluginPackageView> = {}): PluginPackageView {
  return {
    name: 'dsh-better-sidebar',
    version: '0.16.0',
    kind: 'bundle',
    trust: 'external',
    stage: 'runtime',
    installed: true,
    enabled: true,
    status: 'running',
    cordisSameCopy: true,
    rows: [],
    overrides: [],
    addable: [],
    liveReload: true,
    ...overrides,
  }
}

function preset(overrides: Partial<PresetGroup> = {}): PresetGroup {
  return { id: 'standard', trust: 'system', name: '标准', isDefault: true, rows: [], ...overrides }
}

const IDLE_INSTALL: InstallState = {
  open: false, spec: '', enable: true, phase: 'idle', log: '', installed: [], enabled: [], installedOnly: [], plain: [], removed: [], failure: null,
}

const READY: PluginManagerState = {
  status: 'ready',
  packages: [],
  presets: [],
  globalModules: [],
  selectedPreset: null,
  busy: [],
  notice: null,
  install: IDLE_INSTALL,
  confirm: null,
}

const STANDARD_TARGET = { kind: 'preset', preset: 'standard' } as const

function renderTab(state: Partial<PluginManagerState> = {}) {
  const store = createSnapshotStore<PluginManagerState>({ ...READY, ...state })
  const actions = {
    ensure: vi.fn(),
    refresh: vi.fn(),
    openInstall: vi.fn(),
    closeInstall: vi.fn(),
    editInstallSpec: vi.fn(),
    toggleInstallEnable: vi.fn(),
    runInstall: vi.fn(),
    setEnabled: vi.fn(),
    retry: vi.fn(),
    uninstall: vi.fn(),
    confirm: vi.fn(),
    cancelConfirm: vi.fn(),
    addRow: vi.fn(),
    removeRow: vi.fn(),
    setRowDisabled: vi.fn(),
    selectPreset: vi.fn(),
    dismissNotice: vi.fn(),
  }
  const props = {
    t,
    ...actions,
    presetName: (candidate: PresetGroup) => candidate.name ?? candidate.id,
    usePluginManager: bindSnapshotSelector(store),
  } as unknown as PluginManagerSettingsTabProps
  render(<PluginManagerSettingsTab {...props} />)
  return { store, actions, set: (next: Partial<PluginManagerState>) => { act(() => { store.set({ ...store.getSnapshot(), ...next }) }) } }
}

describe('locale dictionaries', () => {
  it('pair every harness module name with its description in both languages', () => {
    const names = Object.keys(zh).filter(key => key.startsWith('name.'))
    expect(names.length).toBeGreaterThan(20)
    for (const key of names) {
      const partner = key.replace(/^name\./, 'desc.') as PluginManagerLocaleKey
      expect(zh[partner]).toBeTypeOf('string')
      expect(en[partner]).toBeTypeOf('string')
    }
  })
})

describe('PluginManagerSettingsTab', () => {
  it('asks the store once mounted and renders the loading, unavailable, error, and empty states', () => {
    const { actions, set } = renderTab({ status: 'loading' })
    expect(actions.ensure).toHaveBeenCalledTimes(1)
    expect(screen.getByText(en.loading)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.addPlugin })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: en.refresh })).toHaveProperty('disabled', true)

    set({ status: 'unavailable' })
    expect(screen.getByRole('status').textContent).toBe(en.unavailable)

    set({ status: 'error' })
    expect(screen.getByRole('alert').textContent).toBe(en.error)
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    expect(actions.refresh).toHaveBeenCalledTimes(1)
    expect(screen.getByText(en.empty)).toBeTruthy()
    expect(screen.getByText(en.presetNoRoster)).toBeTruthy()

    set({ status: 'ready' })
    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    fireEvent.click(screen.getByRole('button', { name: en.addPlugin }))
    expect(actions.refresh).toHaveBeenCalledTimes(2)
    expect(actions.openInstall).toHaveBeenCalledTimes(1)
  })

  it('lists every package as a card, tags only restarts, problems, and built-ins, and names what waits for a restart', () => {
    const { version: _unversioned, ...firstPartyPackage } = pkg({
      name: '@deepseek-ai/dsh-bundle-first-party', title: 'First party', trust: 'builtin', stage: 'boot',
    })
    const { actions } = renderTab({
      packages: [
        pkg({ description: 'A sidebar.' }),
        firstPartyPackage,
        pkg({ name: 'unknown', trust: 'builtin', kind: 'plugin', status: 'plain' }),
        pkg({ name: 'builtin-lib', trust: 'builtin', kind: 'library', status: 'plain' }),
        pkg({ name: 'broken-bundle', enabled: false, status: 'not-enableable', reason: 'foreign cordis' }),
        pkg({ name: 'dsh-tool-foo', kind: 'plugin', status: 'plain' }),
        pkg({ name: 'some-lib', kind: 'library', status: 'plain' }),
        pkg({ name: 'pending-bundle', title: 'Pending', enabled: true, status: 'restart-required' }),
        pkg({ name: 'dsh-untitled', enabled: false, status: 'restart-required', installed: false }),
        pkg({ name: 'off-bundle', enabled: false, status: 'disabled' }),
      ],
    })
    expect(screen.getByText(en.restartBanner.replace('{names}', 'Pending, untitled'))).toBeTruthy()
    expect(document.querySelector('[data-plugin-count]')?.getAttribute('data-plugin-count')).toBe('10')
    // No kind tag, no running or off tag: the switch says that.
    expect(screen.getByText(en.statusProblem)).toBeTruthy()
    expect(screen.getAllByText(en.statusRestart)).toHaveLength(2)
    expect(screen.getAllByText(en.builtinTag)).toHaveLength(3)
    expect(screen.getByText('A sidebar.')).toBeTruthy()
    expect(document.querySelectorAll('[data-kind]')).toHaveLength(6)

    const sidebar = screen.getByRole('switch', { name: 'Enable better-sidebar' }) as HTMLButtonElement
    expect(sidebar.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(sidebar)
    expect(actions.setEnabled).toHaveBeenCalledWith('dsh-better-sidebar', false)
    expect(screen.getByRole('switch', { name: 'Enable broken-bundle' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('switch', { name: 'Enable off-bundle' }).getAttribute('aria-checked')).toBe('false')
    // A built-in pack keeps a locked switch in the same list; a built-in plugin or library has none.
    const firstParty = screen.getByRole('switch', { name: 'Enable First party' }) as HTMLButtonElement
    expect(firstParty.disabled).toBe(true)
    expect(firstParty.title).toBe(en.builtinLocked)
    expect(screen.queryByRole('switch', { name: 'Enable unknown' })).toBeNull()
    expect(screen.queryByRole('switch', { name: 'Enable tool-foo' })).toBeNull()

    // Uninstall lives in the expanded card, for installed packages the person added.
    fireEvent.click(screen.getByRole('button', { name: 'Show better-sidebar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall better-sidebar' }))
    expect(actions.uninstall).toHaveBeenCalledWith('dsh-better-sidebar')
    fireEvent.click(screen.getByRole('button', { name: 'Show untitled' }))
    expect(screen.queryByRole('button', { name: 'Uninstall untitled' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show First party' }))
    expect(document.querySelector('[data-plugin-package="@deepseek-ai/dsh-bundle-first-party"] dd')?.textContent).toBe(en.sourceBuiltin)
    expect(screen.queryByRole('button', { name: 'Uninstall First party' })).toBeNull()
    expect(screen.queryByText(en.versionLabel)).toBeNull()
  })

  it('expands a plugin pack into its facts and components, and retries a failing one', () => {
    const { actions, set } = renderTab({
      packages: [
        pkg({
          status: 'partial',
          reason: 'one row failed',
          rows: [
            { entryId: 'include:better-sidebar', rowId: 'better-sidebar', moduleName: 'dsh-better-sidebar', enabled: true, phase: 'active' },
            { entryId: 'include:off', rowId: 'off', moduleName: 'dsh-better-sidebar/off', enabled: false, disabledBy: 'user', phase: null },
            { entryId: 'include:gated', rowId: 'gated', moduleName: 'dsh-better-sidebar/gated', enabled: false, disabledBy: 'composition', phase: null },
            { entryId: 'include:crash', rowId: 'crash', moduleName: 'dsh-better-sidebar/crash', enabled: true, phase: 'failed', failure: { stage: 'apply', message: 'boom' } },
          ],
        }),
        pkg({ name: 'no-rows', enabled: false, status: 'disabled' }),
        pkg({ name: 'dsh-tool-foo', kind: 'plugin', status: 'plain' }),
        pkg({ name: '@deepseek-ai/dsh-core-broken', title: 'Core', trust: 'builtin', status: 'failed' }),
      ],
    })
    fireEvent.click(screen.getByRole('button', { name: 'Show better-sidebar' }))
    expect(screen.getByText(`${en.reasonLabel}: one row failed`)).toBeTruthy()
    expect(screen.getByText('0.16.0')).toBeTruthy()
    expect(screen.getByText(en.sourceLocal)).toBeTruthy()
    expect(screen.getByRole('img', { name: en.rowPhaseActive })).toBeTruthy()
    // A component shows the id its pack declared, not the tree-wide entry id.
    expect(document.querySelector('[data-plugin-row="include:better-sidebar"]')?.textContent).toContain('better-sidebar')
    expect(document.querySelector('[data-plugin-row="include:off"]')?.textContent).toContain(en.partDisabledByUser)
    expect(document.querySelector('[data-plugin-row="include:gated"]')?.textContent).toContain(en.partDisabledByComposition)
    expect(screen.getByText('boom')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: en.retryPackage }))
    expect(actions.retry).toHaveBeenCalledWith('dsh-better-sidebar')

    // A busy package keeps its controls inert.
    set({ busy: ['dsh-better-sidebar'] })
    expect(screen.getByRole('button', { name: en.retryPackage })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Uninstall better-sidebar' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('switch', { name: 'Enable better-sidebar' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: 'Hide better-sidebar' }))
    expect(screen.queryByText(en.partsLabel)).toBeNull()

    // A pack without components says so; a plugin expands into its facts alone,
    // and opening one card closes the other.
    fireEvent.click(screen.getByRole('button', { name: 'Show no-rows' }))
    expect(screen.getByText(en.partsEmpty)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show tool-foo' }))
    expect(screen.getByText(en.sourceLocal)).toBeTruthy()
    expect(screen.queryByText(en.partsEmpty)).toBeNull()
    // Only a pack with failing components offers a retry; a built-in one retries but never uninstalls.
    expect(screen.queryByRole('button', { name: en.retryPackage })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show Core' }))
    fireEvent.click(screen.getByRole('button', { name: en.retryPackage }))
    expect(actions.retry).toHaveBeenLastCalledWith('@deepseek-ai/dsh-core-broken')
    expect(screen.queryByRole('button', { name: 'Uninstall Core' })).toBeNull()
  })

  it('offers Add to… for a plugin with importable modules, marking the targets it already joined', () => {
    const { actions } = renderTab({
      packages: [
        pkg({ name: 'dsh-tool-foo', kind: 'plugin', status: 'plain', addable: [{ moduleName: 'dsh-tool-foo', declaredName: '.', ok: true }] }),
        pkg({
          name: 'multi',
          kind: 'plugin',
          status: 'plain',
          addable: [
            { moduleName: 'multi/a', declaredName: './a', title: 'A tool', ok: true },
            { moduleName: 'multi/b', declaredName: './b', ok: true },
            { moduleName: 'multi/c', declaredName: './c', ok: false, error: 'cannot import' },
          ],
        }),
        pkg({ name: 'unloadable', kind: 'plugin', status: 'plain', reason: 'the package failed to import: x' }),
      ],
      presets: [
        preset({ rows: [{ entryId: 'fixture', moduleName: 'dsh-tool-foo', enabled: true, fiberPhase: null, source: 'user' }] }),
        preset({ id: 'research', trust: 'user', name: 'Research', isDefault: false }),
        preset({ id: 'broken', trust: 'user', name: 'Broken', isDefault: false, broken: 'bad yaml' }),
      ],
      globalModules: ['multi/a'],
    })
    // A plugin whose import failed offers nothing and reads as a problem.
    expect(screen.getAllByRole('button', { name: en.addTo })).toHaveLength(2)
    expect(screen.getByText(en.statusProblem)).toBeTruthy()

    const [foo, multi] = screen.getAllByRole('button', { name: en.addTo })
    fireEvent.click(foo!)
    expect(screen.getByRole('menuitem', { name: en.addToGlobal })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Preset: 标准 (added)' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Preset: Broken' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Preset: Research' }))
    expect(actions.addRow).toHaveBeenCalledWith('dsh-tool-foo', '.', { kind: 'preset', preset: 'research' })
    fireEvent.click(foo!)
    fireEvent.click(screen.getByRole('menuitem', { name: en.addToGlobal }))
    expect(actions.addRow).toHaveBeenLastCalledWith('dsh-tool-foo', '.', { kind: 'global' })
    fireEvent.click(foo!)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menuitem')).toBeNull()

    // Several importable modules nest their targets under the module.
    fireEvent.click(multi!)
    expect(screen.getByText('A tool')).toBeTruthy()
    expect(screen.getByText('./b')).toBeTruthy()
    expect(screen.queryByText('./c')).toBeNull()
  })

  it('renders the selected preset composition as cards with harness names, local marks, switches, and removal', () => {
    const rows: PresetGroup['rows'] = [
      { entryId: 'include:agent-presets:persona', moduleName: '@deepseek-ai/dsh-persona', enabled: true, fiberPhase: 'active', source: 'preset' },
      { entryId: 'include:agent-presets:tool-subagent-fork', moduleName: '@deepseek-ai/dsh-tool-subagent', enabled: true, fiberPhase: null, source: 'preset' },
      { entryId: 'nameless', moduleName: '@deepseek-ai/dsh-unknown-thing', enabled: true, fiberPhase: null, source: 'preset' },
      { entryId: 'extra', moduleName: '@fixture/extra', enabled: false, fiberPhase: null, source: 'user', disabledBy: 'user' },
      { entryId: 'gated', moduleName: '@fixture/gated', enabled: false, fiberPhase: null, source: 'preset', disabledBy: 'composition' },
      { entryId: 'pwsh', moduleName: '@deepseek-ai/dsh-tool-pwsh', enabled: 'conditional', fiberPhase: null, source: 'preset' },
      { entryId: 'crashy', moduleName: '@fixture/crashy', enabled: true, fiberPhase: 'failed', source: 'preset' },
      { entryId: null, moduleName: '@deepseek-ai/dsh-tool-todo', enabled: true, fiberPhase: null, source: 'preset' },
      { entryId: 'foo', moduleName: 'dsh-tool-foo', enabled: true, fiberPhase: null, source: 'user' },
      { entryId: 'sub', moduleName: 'multi/a', enabled: true, fiberPhase: null, source: 'user' },
    ]
    const { actions, set } = renderTab({
      packages: [
        pkg({ name: 'dsh-tool-foo', kind: 'plugin', status: 'plain', title: 'Foo tool', description: 'A foo.' }),
        pkg({ name: '@fixture/extra', kind: 'plugin', status: 'plain' }),
        pkg({ name: 'multi', kind: 'plugin', status: 'plain', addable: [{ moduleName: 'multi/a', declaredName: './a', title: 'A tool', ok: true }] }),
      ],
      presets: [preset({ rows }), preset({ id: 'research', trust: 'user', name: 'Research', isDefault: false })],
    })
    const switcher = screen.getByRole('button', { name: en.switcherLabel })
    expect(switcher.textContent).toBe('标准 (default)')
    // Harness modules read by their dictionary names: the row id first, then the module.
    expect(screen.getByText(en['name.persona'])).toBeTruthy()
    expect(screen.getByText(en['desc.persona'])).toBeTruthy()
    expect(screen.getByText(en['name.tool-subagent-fork'])).toBeTruthy()
    expect(screen.getByText(en['name.tool-todo'])).toBeTruthy()
    expect(screen.getByText('unknown-thing')).toBeTruthy()
    expect(screen.getByText('@deepseek-ai/dsh-unknown-thing')).toBeTruthy()
    // Installed packages read by their manifest title, an addable module by its own.
    expect(screen.getAllByText('Foo tool')).toHaveLength(2)
    expect(screen.getAllByText('A foo.')).toHaveLength(2)
    expect(screen.getByText('A tool')).toBeTruthy()
    // Only the local mark and the problem tag; off and conditional rows show through their switches.
    expect(screen.getAllByText(en.localTag)).toHaveLength(5)
    expect(screen.getByText(en.rowStateFailed)).toBeTruthy()
    expect(document.querySelectorAll('[data-preset-row] [data-kind]')).toHaveLength(6)
    expect(screen.getByText(en.rowNoId)).toBeTruthy()
    expect(screen.queryByRole('switch', { name: `Enable ${en['name.tool-todo']}` })).toBeNull()
    expect(screen.getByRole('switch', { name: `Enable ${en['name.tool-pwsh']}` }).getAttribute('aria-checked')).toBe('true')

    fireEvent.click(screen.getByRole('switch', { name: `Enable ${en['name.persona']}` }))
    expect(actions.setRowDisabled).toHaveBeenCalledWith(STANDARD_TARGET, 'persona', true)
    const extra = screen.getByRole('switch', { name: 'Enable extra' })
    expect(extra.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(extra)
    expect(actions.setRowDisabled).toHaveBeenLastCalledWith(STANDARD_TARGET, 'extra', false)
    const gated = screen.getByRole('switch', { name: 'Enable gated' }) as HTMLButtonElement
    expect(gated.disabled).toBe(true)
    expect(gated.title).toBe(en.rowLockedByComposition)
    fireEvent.click(screen.getByRole('button', { name: 'Remove extra from this preset' }))
    expect(actions.removeRow).toHaveBeenCalledWith(STANDARD_TARGET, 'extra')
    expect(screen.queryByRole('button', { name: `Remove ${en['name.persona']} from this preset` })).toBeNull()

    set({ busy: [rowKey(STANDARD_TARGET, 'persona')] })
    expect(screen.getByRole('switch', { name: `Enable ${en['name.persona']}` })).toHaveProperty('disabled', true)

    fireEvent.click(switcher)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menuitem')).toBeNull()
    fireEvent.click(switcher)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Research' }))
    expect(actions.selectPreset).toHaveBeenCalledWith('research')
    set({ selectedPreset: 'research' })
    expect(screen.getByText(en.presetRowsEmpty)).toBeTruthy()
    set({ selectedPreset: 'broken', presets: [preset({ id: 'broken', trust: 'user', name: 'Broken', isDefault: false, broken: 'bad yaml' })] })
    expect(screen.getByRole('button', { name: en.switcherLabel }).textContent).toBe('Broken (failed to load)')
    expect(screen.getByRole('alert').textContent).toBe('bad yaml')
  })

  it('drives the install dialog through its phases and words each outcome', () => {
    const { actions, set } = renderTab({ install: { ...IDLE_INSTALL, open: true } })
    expect(screen.getByText(en.installExample)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.installRun })).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByRole('textbox', { name: en.installSpecLabel }), { target: { value: 'dsh-x' } })
    expect(actions.editInstallSpec).toHaveBeenCalledWith('dsh-x')
    fireEvent.click(screen.getByRole('checkbox'))
    expect(actions.toggleInstallEnable).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(en.installLogToggle)).toBeNull()

    set({ install: { ...IDLE_INSTALL, open: true, spec: ' dsh-x ' } })
    fireEvent.click(screen.getByRole('button', { name: en.installRun }))
    expect(actions.runInstall).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    expect(actions.closeInstall).toHaveBeenCalledTimes(1)

    set({ install: { ...IDLE_INSTALL, open: true, spec: 'dsh-x', phase: 'running', log: 'Progress' } })
    expect(screen.getByText(en.installRunning.replace('{spec}', 'dsh-x'))).toBeTruthy()
    expect(screen.getByText(en.installLogToggle)).toBeTruthy()
    expect((document.querySelector('details') as HTMLDetailsElement).open).toBe(false)
    expect(screen.getByRole('button', { name: en.installRun })).toHaveProperty('disabled', true)

    set({
      install: {
        ...IDLE_INSTALL,
        open: true,
        spec: 'dsh-x',
        phase: 'done',
        log: 'Done',
        installed: ['a', 'b', 'c', 'd'],
        enabled: ['a'],
        installedOnly: ['b'],
        plain: ['c'],
        removed: [
          { name: 'lodash', reason: 'declares neither a dsh bundle nor a plugin module' },
          { name: 'clash', reason: 'row "x" is already declared by y' },
        ],
      },
    })
    expect(screen.getByText(en.installDoneEnabled.replace('{name}', 'a'))).toBeTruthy()
    expect(screen.getByText(en.installDoneBundle.replace('{name}', 'b'))).toBeTruthy()
    expect(screen.getByText(en.installDonePlugin.replace('{name}', 'c'))).toBeTruthy()
    expect(screen.getByText(en.installDoneOther.replace('{name}', 'd'))).toBeTruthy()
    expect(screen.getByText(en.installRemovedLibrary.replace('{name}', 'lodash'))).toBeTruthy()
    expect(screen.getByText(en.installRemovedConflict.replace('{name}', 'clash').replace('{reason}', 'row "x" is already declared by y'))).toBeTruthy()
    expect(screen.getByRole('button', { name: en.installClose })).toBeTruthy()

    set({ install: { ...IDLE_INSTALL, open: true, spec: 'dsh-x', phase: 'done' } })
    expect(screen.getByText(en.installDoneNothing)).toBeTruthy()

    set({ install: { ...IDLE_INSTALL, open: true, spec: 'dsh-x', phase: 'failed', log: 'ERR', failure: { code: 'plugins/install-failed', reason: 'ERR' } } })
    expect(screen.getByRole('alert').textContent).toBe(en.installFailed)
    expect((document.querySelector('details') as HTMLDetailsElement).open).toBe(true)
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'dsh-x', phase: 'failed', failure: { code: 'plugins/busy', reason: 'add x' } } })
    expect(screen.getByRole('alert').textContent).toBe(en.busy.replace('{reason}', 'add x'))
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'dsh-x', phase: 'failed', failure: null } })
    expect(screen.getByRole('alert').textContent).toBe(en.installFailed)
  })

  it('names what still uses a package in the confirmation and runs the action through it', () => {
    const { actions, set } = renderTab({
      packages: [pkg(), pkg({ name: 'dsh-other', title: 'Other' })],
      presets: [preset()],
      confirm: { action: 'disable', packageName: 'dsh-better-sidebar', dependents: undefined },
    })
    expect(screen.getByRole('dialog', { name: en.confirmDisableTitle.replace('{name}', 'better-sidebar') })).toBeTruthy()
    expect(screen.getByText(en.confirmChecking)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.confirmDisable })).toHaveProperty('disabled', true)

    set({
      confirm: {
        action: 'disable',
        packageName: 'dsh-better-sidebar',
        dependents: {
          services: [{ service: 'sidebar', providedBy: 'include:sidebar', injectedBy: ['include:tool-bash', 'include:custom'] }],
          references: [
            { target: { kind: 'global' }, rowId: 'r1', moduleName: 'dsh-other/x' },
            { target: { kind: 'preset', preset: 'standard' }, rowId: 'r2', moduleName: '@fixture/other' },
            { target: { kind: 'preset', preset: 'ghost' }, rowId: 'r3', moduleName: 'dsh-better-sidebar' },
          ],
        },
      },
    })
    expect(screen.getByText(en.dependentService.replace('{rows}', `${en['name.tool-bash']}, custom`))).toBeTruthy()
    expect(screen.getByText(en.dependentReferenceGlobal.replace('{row}', 'Other'))).toBeTruthy()
    expect(screen.getByText(en.dependentReferencePreset.replace('{name}', '标准').replace('{row}', 'r2'))).toBeTruthy()
    expect(screen.getByText(en.dependentReferencePreset.replace('{name}', 'ghost').replace('{row}', 'better-sidebar'))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.confirmDisable }))
    expect(actions.confirm).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    expect(actions.cancelConfirm).toHaveBeenCalledTimes(1)

    set({ confirm: { action: 'uninstall', packageName: 'dsh-other', dependents: { services: [], references: [] } } })
    expect(screen.getByRole('dialog', { name: en.confirmUninstallTitle.replace('{name}', 'Other') })).toBeTruthy()
    expect(screen.queryByText(en.confirmDependents)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.confirmUninstall }))
    expect(actions.confirm).toHaveBeenCalledTimes(2)
  })

  it('words every notice and dismisses it', () => {
    const { actions, set } = renderTab({ notice: { kind: 'restart', packageName: 'x' } })
    expect(screen.getByRole('status').textContent).toContain(en.restartNotice)
    set({ notice: { kind: 'done' } })
    expect(screen.getByRole('status').textContent).toContain(en.doneNotice)
    const failures: [string, string][] = [
      ['plugins/not-enableable', en.notEnableable.replace('{reason}', 'r')],
      ['plugins/enable-failed', en.enableFailed.replace('{reason}', 'r')],
      ['plugins/row-conflict', en.rowConflict.replace('{row}', 'row-1')],
      ['plugins/not-installed', en.notInstalled.replace('{name}', 'pkg-1')],
      ['plugins/busy', en.busy.replace('{reason}', 'r')],
      ['plugins/agents-running', en.agentsRunning.replace('{reason}', 'r')],
      ['plugins/install-failed', en.installFailed],
      ['gateway/internal', en.actionFailed.replace('{reason}', 'r')],
    ]
    for (const [code, text] of failures) {
      set({ notice: { kind: 'failed', code, reason: 'r', packageName: 'pkg-1', rowId: 'row-1' } })
      expect(screen.getByRole('alert').textContent).toContain(text)
    }
    set({ notice: { kind: 'failed', code: 'plugins/row-conflict', reason: 'r' } })
    expect(screen.getByRole('alert').textContent).toContain(en.rowConflict.replace('{row}', ''))
    set({ notice: { kind: 'failed', code: 'plugins/not-installed', reason: 'r' } })
    expect(screen.getByRole('alert').textContent).toContain(en.notInstalled.replace('{name}', ''))
    fireEvent.click(screen.getByRole('button', { name: en.dismiss }))
    expect(actions.dismissNotice).toHaveBeenCalledTimes(1)
  })
})
