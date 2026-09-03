// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginPackageView } from '@deepseek-ai/dsh-api-remotes/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { PluginManagerSettingsTab } from '../src/client/PluginManagerSettingsTab.tsx'
import type { PluginManagerSettingsTabProps } from '../src/client/PluginManagerSettingsTab.tsx'
import type { PluginManagerState, PresetGroup } from '../src/client/manager-store.ts'
import { en, type PluginManagerLocaleKey } from '../src/client/locales.ts'

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

const READY: PluginManagerState = {
  status: 'ready',
  packages: [],
  presets: [],
  selectedPreset: null,
  busy: [],
  notice: null,
  install: { open: false, spec: '', enable: true, phase: 'idle', log: '', installed: [] },
  confirm: null,
}

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
    acknowledgeConfirm: vi.fn(),
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

describe('PluginManagerSettingsTab', () => {
  it('asks the store once mounted and renders the loading, unavailable, error, and empty states', () => {
    const { actions, set } = renderTab({ status: 'loading' })
    expect(actions.ensure).toHaveBeenCalledTimes(1)
    expect(screen.getByText(en.loading)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.addPlugin })).toHaveProperty('disabled', true)

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

  it('lists packages with their tags and switches, and names what waits for a restart', () => {
    const { version: _unversioned, ...firstPartyPackage } = pkg({
      name: '@deepseek-ai/dsh-bundle-first-party', title: 'First party', trust: 'builtin', stage: 'boot',
    })
    const { actions } = renderTab({
      packages: [
        pkg(),
        firstPartyPackage,
        pkg({ name: 'broken-bundle', enabled: false, status: 'not-enableable', reason: 'foreign cordis' }),
        pkg({ name: 'dsh-tool-foo', kind: 'plugin', status: 'plain' }),
        pkg({ name: 'some-lib', kind: 'library', status: 'plain' }),
        pkg({ name: 'pending-bundle', title: 'Pending', enabled: true, status: 'restart-required' }),
        pkg({ name: 'dsh-untitled', enabled: false, status: 'restart-required' }),
      ],
    })
    expect(screen.getByText(en.restartBanner.replace('{names}', 'Pending, untitled'))).toBeTruthy()
    expect(document.querySelector('[data-plugin-count]')?.getAttribute('data-plugin-count')).toBe('7')
    expect(screen.getAllByText(en.externalTag)).toHaveLength(6)
    expect(screen.getByText(en.builtinTag)).toBeTruthy()
    expect(screen.getByText(en.stageBootTag)).toBeTruthy()
    expect(screen.getByText(en.pluginTag)).toBeTruthy()
    expect(screen.getByText(en.libraryTag)).toBeTruthy()
    expect(screen.getByText(en.statusNotEnableable)).toBeTruthy()
    expect(screen.getAllByText(en.statusPlain)).toHaveLength(2)
    expect(screen.getByText('dsh-better-sidebar · 0.16.0')).toBeTruthy()

    const sidebar = screen.getByRole('switch', { name: 'Enable better-sidebar' }) as HTMLButtonElement
    expect(sidebar.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(sidebar)
    expect(actions.setEnabled).toHaveBeenCalledWith('dsh-better-sidebar', false)
    const firstParty = screen.getByRole('switch', { name: 'Enable First party' }) as HTMLButtonElement
    expect(firstParty.disabled).toBe(true)
    expect(firstParty.title).toBe(en.builtinLocked)
    expect(screen.getByRole('switch', { name: 'Enable broken-bundle' })).toHaveProperty('disabled', true)
    // Plain packages carry no switch.
    expect(screen.queryByRole('switch', { name: 'Enable tool-foo' })).toBeNull()
  })

  it('expands a package into its facts, rows, addable modules, and actions', () => {
    const { actions, set } = renderTab({
      packages: [pkg({
        description: 'A sidebar.',
        status: 'partial',
        reason: 'one row failed',
        enginesDsh: '>=0.1.0',
        probedAt: '2026-09-04T00:00:00Z',
        overrides: ['ui-sidebar'],
        rows: [
          { entryId: 'dsh-better-sidebar/better-sidebar', originalId: 'better-sidebar', moduleName: 'dsh-better-sidebar', enabled: true, phase: 'active' },
          { entryId: 'dsh-better-sidebar/off', moduleName: 'dsh-better-sidebar/off', enabled: false, disabledBy: 'user', phase: null },
          { entryId: 'dsh-better-sidebar/gated', moduleName: 'dsh-better-sidebar/gated', enabled: false, disabledBy: 'composition', phase: null },
          { entryId: 'dsh-better-sidebar/crash', moduleName: 'dsh-better-sidebar/crash', enabled: true, phase: 'failed', failure: { stage: 'apply', message: 'boom' } },
        ],
        addable: [
          { moduleName: 'dsh-better-sidebar/tool', declaredName: './tool', title: 'Sidebar tool', ok: true },
          { moduleName: 'dsh-better-sidebar/broken', declaredName: './broken', ok: false, error: 'cannot import' },
        ],
      })],
      presets: [preset()],
    })
    const expand = screen.getByRole('button', { name: 'Show better-sidebar' })
    fireEvent.click(expand)
    expect(screen.getByText('A sidebar.')).toBeTruthy()
    expect(screen.getByText(`${en.reasonLabel}: one row failed`)).toBeTruthy()
    expect(screen.getByText('>=0.1.0')).toBeTruthy()
    expect(screen.getByText(en.cordisSame)).toBeTruthy()
    expect(screen.getByText('2026-09-04T00:00:00Z')).toBeTruthy()
    expect(screen.getByText('ui-sidebar')).toBeTruthy()
    expect(screen.getByRole('img', { name: en.rowPhaseActive })).toBeTruthy()
    // A prefixed row shows the id its bundle declared.
    expect(document.querySelector('[data-plugin-row="dsh-better-sidebar/better-sidebar"]')?.textContent).toContain('better-sidebar')
    expect(screen.getByText(en.rowDisabledByUser)).toBeTruthy()
    expect(screen.getByText(en.rowDisabledByComposition)).toBeTruthy()
    expect(screen.getByText('boom')).toBeTruthy()
    expect(screen.getByText('Sidebar tool')).toBeTruthy()
    expect(screen.getByText(en.addableNotOk)).toBeTruthy()
    expect(screen.getByText('cannot import')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: en.addTo }))
    fireEvent.click(screen.getByRole('menuitem', { name: en.addToGlobal }))
    expect(actions.addRow).toHaveBeenCalledWith('dsh-better-sidebar', './tool', { kind: 'global' })
    fireEvent.click(screen.getByRole('button', { name: en.addTo }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Preset: 标准' }))
    expect(actions.addRow).toHaveBeenLastCalledWith('dsh-better-sidebar', './tool', { kind: 'preset', preset: 'standard' })
    fireEvent.click(screen.getByRole('button', { name: en.addTo }))
    fireEvent.click(screen.getByRole('button', { name: en.addTo }))
    expect(screen.queryByRole('menuitem')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.addTo }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menuitem')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: en.retryPackage }))
    expect(actions.retry).toHaveBeenCalledWith('dsh-better-sidebar')
    fireEvent.click(screen.getByRole('button', { name: en.uninstall }))
    expect(actions.uninstall).toHaveBeenCalledWith('dsh-better-sidebar')

    // A busy package keeps its controls inert.
    set({ busy: ['dsh-better-sidebar'] })
    expect(screen.getByRole('button', { name: en.retryPackage })).toHaveProperty('disabled', true)
    expect(screen.getByRole('switch', { name: 'Enable better-sidebar' })).toHaveProperty('disabled', true)

    fireEvent.click(screen.getByRole('button', { name: 'Hide better-sidebar' }))
    expect(screen.queryByText('A sidebar.')).toBeNull()
  })

  it('names an unknown or foreign cordis copy, an empty row list, and hides actions a package does not offer', () => {
    renderTab({
      packages: [
        pkg({ name: 'foreign', cordisSameCopy: false, installed: false, status: 'disabled', enabled: false }),
        pkg({ name: 'unknown', cordisSameCopy: null, trust: 'builtin', kind: 'plugin', status: 'plain' }),
      ],
    })
    fireEvent.click(screen.getByRole('button', { name: 'Show foreign' }))
    expect(screen.getByText(en.cordisForeign)).toBeTruthy()
    expect(screen.getByText(en.rowsEmpty)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.uninstall })).toBeNull()
    expect(screen.queryByRole('button', { name: en.retryPackage })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show unknown' }))
    expect(screen.getByText(en.cordisUnknown)).toBeTruthy()
    expect(screen.queryByText(en.rowsLabel)).toBeNull()
  })

  it('renders the selected preset composition with row switches, removal, and the switcher', () => {
    const rows: PresetGroup['rows'] = [
      { entryId: 'bash', moduleName: '@deepseek-ai/dsh-tool-bash', enabled: true, fiberPhase: 'active', source: 'preset' },
      { entryId: 'extra', moduleName: '@fixture/extra', enabled: false, fiberPhase: null, source: 'user', disabledBy: 'user' },
      { entryId: 'gated', moduleName: '@fixture/gated', enabled: false, fiberPhase: null, source: 'preset', disabledBy: 'composition' },
      { entryId: 'pwsh', moduleName: '@fixture/pwsh', enabled: 'conditional', fiberPhase: null, source: 'preset' },
      { entryId: 'crashy', moduleName: '@fixture/crashy', enabled: true, fiberPhase: 'failed', source: 'preset' },
      { entryId: null, moduleName: '@fixture/anonymous', enabled: true, fiberPhase: null, source: 'preset' },
    ]
    const { actions, set } = renderTab({
      presets: [preset({ rows }), preset({ id: 'research', trust: 'user', name: 'Research', isDefault: false })],
    })
    const switcher = screen.getByRole('button', { name: en.switcherLabel })
    expect(switcher.textContent).toBe('标准 (default)')
    expect(screen.getByRole('img', { name: en.rowPhaseActive })).toBeTruthy()
    expect(screen.getByText(en.rowSourceUser)).toBeTruthy()
    expect(screen.getByText(en.rowDisabledByUser)).toBeTruthy()
    expect(screen.getByText(en.rowDisabledByComposition)).toBeTruthy()
    expect(screen.getByText(en.rowConditional)).toBeTruthy()
    expect(screen.getByText(en.rowPhaseFailed)).toBeTruthy()
    expect(screen.getByText(en.rowNoId)).toBeTruthy()
    expect(screen.queryByRole('switch', { name: 'Enable row anonymous' })).toBeNull()

    fireEvent.click(screen.getByRole('switch', { name: 'Enable row bash' }))
    expect(actions.setRowDisabled).toHaveBeenCalledWith({ kind: 'preset', preset: 'standard' }, 'bash', true)
    fireEvent.click(screen.getByRole('switch', { name: 'Enable row extra' }))
    expect(actions.setRowDisabled).toHaveBeenLastCalledWith({ kind: 'preset', preset: 'standard' }, 'extra', false)
    fireEvent.click(screen.getByRole('button', { name: 'Remove row extra' }))
    expect(actions.removeRow).toHaveBeenCalledWith({ kind: 'preset', preset: 'standard' }, 'extra')
    expect(screen.queryByRole('button', { name: 'Remove row bash' })).toBeNull()

    fireEvent.click(switcher)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menuitem')).toBeNull()
    fireEvent.click(switcher)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Research' }))
    expect(actions.selectPreset).toHaveBeenCalledWith('research')
    set({ selectedPreset: 'research' })
    expect(screen.getByText(en.presetRowsEmpty)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.switcherLabel }).textContent).toBe('Research')

    set({ busy: ['preset:standard:bash'], selectedPreset: 'standard' })
    expect(screen.getByRole('switch', { name: 'Enable row bash' })).toHaveProperty('disabled', true)

    set({ presets: [preset({ id: 'broken', broken: 'bad yaml', isDefault: false, rows })], selectedPreset: null })
    expect(screen.getByRole('alert').textContent).toBe('bad yaml')
    expect(screen.getByRole('button', { name: en.switcherLabel }).textContent).toBe('标准 (failed to load)')
  })

  it('shows each notice with the Host reason and dismisses it', () => {
    const { actions, set } = renderTab({ notice: { kind: 'restart', packageName: 'x' } })
    expect(screen.getByRole('status').textContent).toContain(en.restartNotice)
    fireEvent.click(screen.getByRole('button', { name: en.dismiss }))
    expect(actions.dismissNotice).toHaveBeenCalledTimes(1)
    set({ notice: { kind: 'done' } })
    expect(screen.getByRole('status').textContent).toContain(en.doneNotice)
    set({ notice: { kind: 'failed', code: 'plugins/not-enableable', reason: 'foreign cordis', packageName: 'x' } })
    expect(screen.getByRole('alert').textContent).toContain('Cannot be enabled: foreign cordis')
    set({ notice: { kind: 'failed', code: 'plugins/enable-failed', reason: 'tree rejected', packageName: 'x' } })
    expect(screen.getByRole('alert').textContent).toContain('tree rejected')
    set({ notice: { kind: 'failed', code: 'plugins/row-conflict', reason: 'taken', rowId: 'r1' } })
    expect(screen.getByRole('alert').textContent).toContain('id r1')
    set({ notice: { kind: 'failed', code: 'plugins/row-conflict', reason: 'taken' } })
    expect(screen.getByRole('alert').textContent).toContain('id .')
    set({ notice: { kind: 'failed', code: 'plugins/not-installed', reason: 'missing', packageName: 'y' } })
    expect(screen.getByRole('alert').textContent).toContain('y is not installed')
    set({ notice: { kind: 'failed', code: 'plugins/not-installed', reason: 'missing' } })
    expect(screen.getByRole('alert').textContent).toContain(' is not installed')
    set({ notice: { kind: 'failed', code: 'gateway/internal', reason: 'offline' } })
    expect(screen.getByRole('alert').textContent).toContain('The action failed: offline')
  })

  it('drives the install dialog through its phases', () => {
    const { actions, set } = renderTab({ install: { open: true, spec: '', enable: true, phase: 'idle', log: '', installed: [] } })
    const dialog = screen.getByRole('dialog', { name: en.installTitle })
    expect(dialog).toBeTruthy()
    const spec = screen.getByLabelText(en.installSpecLabel) as HTMLInputElement
    fireEvent.change(spec, { target: { value: 'pkg' } })
    expect(actions.editInstallSpec).toHaveBeenCalledWith('pkg')
    fireEvent.click(screen.getByLabelText(en.installEnable))
    expect(actions.toggleInstallEnable).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: en.installRun })).toHaveProperty('disabled', true)
    expect(screen.queryByLabelText(en.installLogLabel)).toBeNull()

    set({ install: { open: true, spec: 'pkg', enable: false, phase: 'idle', log: '', installed: [] } })
    fireEvent.click(screen.getByRole('button', { name: en.installRun }))
    expect(actions.runInstall).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    expect(actions.closeInstall).toHaveBeenCalledTimes(1)

    set({ install: { open: true, spec: 'pkg', enable: false, phase: 'running', log: 'Progress', installed: [] } })
    expect(screen.getByRole('button', { name: en.installRunning })).toHaveProperty('disabled', true)
    expect(screen.getByLabelText(en.installLogLabel).textContent).toBe('Progress')
    expect(screen.getByLabelText(en.installSpecLabel)).toHaveProperty('disabled', true)

    set({ install: { open: true, spec: 'pkg', enable: false, phase: 'done', log: 'Progress', installed: ['pkg'] } })
    expect(screen.getByRole('status').textContent).toBe('Installed: pkg')
    set({ install: { open: true, spec: 'pkg', enable: false, phase: 'done', log: '', installed: [] } })
    expect(screen.getByRole('status').textContent).toBe(en.installDoneNothing)
    fireEvent.click(screen.getByRole('button', { name: en.installClose }))
    expect(actions.closeInstall).toHaveBeenCalledTimes(2)

    set({ install: { open: true, spec: 'pkg', enable: false, phase: 'failed', log: 'ERR', installed: [] } })
    expect(screen.getByRole('alert').textContent).toBe(en.installFailed)
    expect(screen.getByLabelText(en.installLogLabel).textContent).toBe('ERR')
    fireEvent.click(screen.getByRole('button', { name: en.close }))
    expect(actions.closeInstall).toHaveBeenCalledTimes(3)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(actions.closeInstall).toHaveBeenCalledTimes(4)

    set({ install: { open: false, spec: '', enable: true, phase: 'idle', log: '', installed: [] } })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('confirms a destructive action only once its dependents are known and acknowledged', () => {
    const { actions, set } = renderTab({
      presets: [preset()],
      confirm: { action: 'uninstall', packageName: 'dsh-better-sidebar', dependents: undefined, acknowledged: false },
    })
    expect(screen.getByRole('dialog', { name: 'Uninstall better-sidebar' })).toBeTruthy()
    expect(screen.getByText(en.confirmUninstallDescription)).toBeTruthy()
    expect(screen.getByText(en.loading)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.confirm })).toHaveProperty('disabled', true)

    set({
      confirm: {
        action: 'uninstall',
        packageName: 'dsh-better-sidebar',
        acknowledged: false,
        dependents: {
          services: [{ service: 'sidebar', providedBy: 'dsh-better-sidebar/better-sidebar', injectedBy: ['ui-x', 'ui-y'] }],
          references: [
            { target: { kind: 'global' }, rowId: 'g1', moduleName: 'dsh-better-sidebar/tool' },
            { target: { kind: 'preset', preset: 'standard' }, rowId: 'p1', moduleName: 'dsh-better-sidebar/tool' },
            { target: { kind: 'preset', preset: 'gone' }, rowId: 'p2', moduleName: 'dsh-better-sidebar/tool' },
          ],
        },
      },
    })
    expect(screen.getByText(en.confirmDependents)).toBeTruthy()
    expect(screen.getByText('Service sidebar (provided by dsh-better-sidebar/better-sidebar) is injected by ui-x, ui-y')).toBeTruthy()
    expect(screen.getByText('Row g1 in the global patch layer names dsh-better-sidebar/tool')).toBeTruthy()
    expect(screen.getByText('Row p1 in preset 标准 names dsh-better-sidebar/tool')).toBeTruthy()
    expect(screen.getByText('Row p2 in preset gone names dsh-better-sidebar/tool')).toBeTruthy()
    expect(screen.getByRole('button', { name: en.confirm })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByLabelText(en.acknowledge))
    expect(actions.acknowledgeConfirm).toHaveBeenCalledWith(true)

    set({
      confirm: {
        action: 'disable', packageName: 'dsh-better-sidebar', acknowledged: true,
        dependents: { services: [], references: [] },
      },
    })
    expect(screen.getByRole('dialog', { name: 'Disable better-sidebar' })).toBeTruthy()
    expect(screen.getByText(en.confirmDisableDescription)).toBeTruthy()
    expect(screen.queryByText(en.confirmDependents)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.confirm }))
    expect(actions.confirm).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    expect(actions.cancelConfirm).toHaveBeenCalledTimes(1)
  })
})
