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
  busy: [],
  notice: null,
  install: IDLE_INSTALL,
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
    confirm: vi.fn(),
    cancelConfirm: vi.fn(),
    addRow: vi.fn(),
    removeRow: vi.fn(),
    setRowDisabled: vi.fn(),
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
    expect(document.querySelectorAll('[data-tone]')).toHaveLength(6)

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

    // Uninstall lives on the package's page, for installed packages the person added.
    fireEvent.click(screen.getByRole('button', { name: 'View better-sidebar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall better-sidebar' }))
    expect(actions.uninstall).toHaveBeenCalledWith('dsh-better-sidebar')
    fireEvent.click(screen.getByRole('button', { name: en.backToList }))
    fireEvent.click(screen.getByRole('button', { name: 'View untitled' }))
    expect(screen.queryByRole('button', { name: 'Uninstall untitled' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.backToList }))
    fireEvent.click(screen.getByRole('button', { name: 'View First party' }))
    expect(document.querySelector('[data-plugin-detail="@deepseek-ai/dsh-bundle-first-party"] dd')?.textContent).toBe(en.sourceBuiltin)
    expect(screen.queryByRole('button', { name: 'Uninstall First party' })).toBeNull()
    expect(screen.queryByText(en.versionLabel)).toBeNull()
  })

  it('opens a plugin pack\'s page with its facts, rows, and overrides, and retries a failing one', () => {
    const { actions, set } = renderTab({
      packages: [
        pkg({
          status: 'partial',
          reason: 'one row failed',
          overrides: ['directory-picker'],
          rows: [
            { entryId: 'include:better-sidebar', rowId: 'better-sidebar', moduleName: 'dsh-better-sidebar', enabled: true, phase: 'active' },
            { entryId: 'include:off', rowId: 'off', moduleName: 'dsh-better-sidebar/off', enabled: false, disabledBy: 'user', phase: null },
            { entryId: 'include:gated', rowId: 'gated', moduleName: 'dsh-better-sidebar/gated', enabled: false, disabledBy: 'composition', phase: null },
            { entryId: 'include:crash', rowId: 'crash', moduleName: 'dsh-better-sidebar/crash', enabled: true, phase: 'failed', failure: { stage: 'apply', message: 'boom' } },
            { entryId: 'include:flaky', rowId: 'flaky', moduleName: 'dsh-better-sidebar/flaky', enabled: true, phase: 'failed' },
            { entryId: 'include:idle', rowId: 'idle', moduleName: 'dsh-better-sidebar/idle', enabled: true, phase: null },
          ],
        }),
        pkg({ name: 'no-rows', enabled: false, status: 'disabled' }),
        pkg({ name: 'dsh-tool-foo', kind: 'plugin', status: 'plain' }),
        pkg({
          name: '@deepseek-ai/dsh-core-broken', title: 'Core', trust: 'builtin', status: 'failed',
          rows: [{ entryId: 'include:core', rowId: 'core', moduleName: '@deepseek-ai/dsh-core-broken', enabled: true, phase: 'active' }],
        }),
      ],
    })
    // The list and its toolbar give way to the page; the crumb leads back.
    fireEvent.click(screen.getByRole('button', { name: 'View better-sidebar' }))
    expect(screen.queryByRole('button', { name: en.addPlugin })).toBeNull()
    expect(screen.getByRole('heading', { name: 'better-sidebar' })).toBeTruthy()
    expect(screen.getByText(`${en.reasonLabel}: one row failed`)).toBeTruthy()
    expect(screen.getByText('0.16.0')).toBeTruthy()
    expect(screen.getByText(en.sourceExternal)).toBeTruthy()
    // Every row on one line, in the pack's order, saying its state; a failure adds its message.
    expect(screen.getByText('6 total · 1 running · 2 off · 2 failed')).toBeTruthy()
    const rowText = (id: string): string | undefined => document.querySelector(`[data-plugin-row="include:${id}"]`)?.textContent
    expect(rowText('better-sidebar')).toBe(`better-sidebar${en.rowPhaseActive}`)
    expect(rowText('off')).toBe(`off${en.partDisabledByUser}`)
    expect(rowText('gated')).toBe(`gated${en.partDisabledByComposition}`)
    expect(rowText('crash')).toBe(`crash${en.rowStateFailed}boom`)
    expect(rowText('flaky')).toBe(`flaky${en.rowStateFailed}`)
    expect(rowText('idle')).toBe(`idle${en.rowStateIdle}`)
    expect(document.querySelector('[data-plugin-row="include:off"]')?.getAttribute('data-state')).toBe('off')
    expect(document.querySelector('[data-plugin-row="include:crash"]')?.getAttribute('data-state')).toBe('failed')
    // A short list has no filter; the built-in rows the pack changes are named.
    expect(screen.queryByRole('searchbox', { name: en.partsFilter })).toBeNull()
    expect(document.querySelector('[data-plugin-overrides]')?.textContent).toContain('directory-picker')
    expect(screen.queryByText(en.modulesLabel)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: en.retryPackage }))
    expect(actions.retry).toHaveBeenCalledWith('dsh-better-sidebar')
    fireEvent.click(screen.getByRole('switch', { name: 'Enable better-sidebar' }))
    expect(actions.setEnabled).toHaveBeenCalledWith('dsh-better-sidebar', false)
    // A busy package keeps its controls inert.
    set({ busy: ['dsh-better-sidebar'] })
    expect(screen.getByRole('button', { name: en.retryPackage })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Uninstall better-sidebar' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('switch', { name: 'Enable better-sidebar' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: en.backToList }))
    expect(screen.queryByText(en.partsLabel)).toBeNull()
    expect(screen.getByRole('button', { name: en.addPlugin })).toBeTruthy()

    // A pack without rows says so; a plugin's page has no rows section; a
    // built-in pack retries but never uninstalls.
    fireEvent.click(screen.getByRole('button', { name: 'View no-rows' }))
    expect(screen.getByText(en.partsEmpty)).toBeTruthy()
    expect(screen.getByText(en.noDescription)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.backToList }))
    fireEvent.click(screen.getByRole('button', { name: 'View tool-foo' }))
    expect(screen.queryByText(en.partsLabel)).toBeNull()
    expect(screen.queryByRole('button', { name: en.retryPackage })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.backToList }))
    fireEvent.click(screen.getByRole('button', { name: 'View Core' }))
    expect(screen.getByText('1 total · 1 running')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.retryPackage }))
    expect(actions.retry).toHaveBeenLastCalledWith('@deepseek-ai/dsh-core-broken')
    expect(screen.queryByRole('button', { name: 'Uninstall Core' })).toBeNull()
    // A package that leaves the list while its page is open drops back to the cards.
    set({ packages: [] })
    expect(screen.getByText(en.empty)).toBeTruthy()
  })

  it('switches the rows of a live external pack, filters a long list, and locks what the pack itself keeps off', () => {
    const userOff = { enabled: false, disabledBy: 'user', phase: null } as const
    const many = Array.from({ length: 11 }, (_, index) => ({
      entryId: `include:row-${String(index)}`, rowId: `row-${String(index)}`, moduleName: 'many', enabled: true, phase: 'active' as const,
    }))
    const { actions, set } = renderTab({
      packages: [
        pkg({
          status: 'partial',
          rows: [
            { entryId: 'include:better-sidebar', rowId: 'better-sidebar', moduleName: 'dsh-better-sidebar', enabled: true, phase: 'active' },
            { entryId: 'include:off', rowId: 'off', moduleName: 'dsh-better-sidebar/off', ...userOff },
            { entryId: 'include:gated', rowId: 'gated', moduleName: 'dsh-better-sidebar/gated', enabled: false, disabledBy: 'composition', phase: null },
            { entryId: 'include:crash', rowId: 'crash', moduleName: 'dsh-better-sidebar/crash', enabled: true, phase: 'failed', failure: { stage: 'apply', message: 'boom' } },
            { entryId: 'conflict:x:taken', rowId: 'taken', moduleName: 'dsh-better-sidebar/taken', enabled: true, phase: null, failure: { stage: 'conflict', message: 'x owns taken' } },
          ],
        }),
        pkg({ name: 'many', rows: many }),
        pkg({ name: 'frozen', liveReload: false, rows: [{ entryId: 'include:frozen', rowId: 'frozen', moduleName: 'frozen', ...userOff }] }),
        pkg({ name: 'parked', enabled: false, status: 'disabled', rows: [{ entryId: 'include:parked', rowId: 'parked', moduleName: 'parked', ...userOff }] }),
        pkg({ name: '@deepseek-ai/dsh-core', title: 'Core', trust: 'builtin', rows: [{ entryId: 'include:core', rowId: 'core', moduleName: '@deepseek-ai/dsh-core', ...userOff }] }),
      ],
    })
    const target = { kind: 'global' } as const
    fireEvent.click(screen.getByRole('button', { name: 'View better-sidebar' }))
    // A row the person switched off switches back on; one the pack itself keeps off is locked and says why.
    const off = screen.getByRole('switch', { name: 'Enable component off' })
    expect(off.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(off)
    expect(actions.setRowDisabled).toHaveBeenLastCalledWith(target, 'off', false)
    const gated = screen.getByRole('switch', { name: 'Enable component gated' })
    expect(gated).toHaveProperty('disabled', true)
    expect(gated.getAttribute('title')).toBe(en.partLockedByComposition)
    // A failing row can be switched off; a row another layer owns has nothing mounted to switch.
    fireEvent.click(screen.getByRole('switch', { name: 'Enable component crash' }))
    expect(actions.setRowDisabled).toHaveBeenLastCalledWith(target, 'crash', true)
    expect(screen.queryByRole('switch', { name: 'Enable component taken' })).toBeNull()
    const sidebar = screen.getByRole('switch', { name: 'Enable component better-sidebar' })
    expect(sidebar.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(sidebar)
    expect(actions.setRowDisabled).toHaveBeenLastCalledWith(target, 'better-sidebar', true)
    // Only the row with a write in flight goes inert; a busy package takes every row with it.
    set({ busy: [rowKey(target, 'better-sidebar')] })
    expect(screen.getByRole('switch', { name: 'Enable component better-sidebar' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('switch', { name: 'Enable component off' })).toHaveProperty('disabled', false)
    set({ busy: ['dsh-better-sidebar'] })
    expect(screen.getByRole('switch', { name: 'Enable component off' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: en.backToList }))
    // A long list gets a filter over the row ids.
    fireEvent.click(screen.getByRole('button', { name: 'View many' }))
    const filter = screen.getByRole('searchbox', { name: en.partsFilter })
    expect(document.querySelectorAll('[data-plugin-row]')).toHaveLength(11)
    fireEvent.change(filter, { target: { value: 'ROW-1' } })
    expect(document.querySelectorAll('[data-plugin-row]')).toHaveLength(2)
    fireEvent.change(filter, { target: { value: 'nope' } })
    expect(screen.getByText(en.partsFilterEmpty)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.backToList }))
    // Rows stay read-only where a switch would not act now: a profile that
    // applies patches at its next start, a pack that is off, and a built-in pack.
    for (const [name, rowId] of [['frozen', 'frozen'], ['parked', 'parked'], ['Core', 'core']] as const) {
      fireEvent.click(screen.getByRole('button', { name: `View ${name}` }))
      expect(document.querySelector(`[data-plugin-row="include:${rowId}"]`)?.textContent).toBe(`${rowId}${en.partDisabledByUser}`)
      expect(screen.queryByRole('switch', { name: `Enable component ${rowId}` })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: en.backToList }))
    }
  })

  it('opens a plugin\'s page with its modules, where each is composed, and an Add to… per module', () => {
    const { actions } = renderTab({
      packages: [
        pkg({
          name: 'dsh-tool-foo', kind: 'plugin', status: 'plain', title: 'Foo tools', reason: 'one module refused',
          addable: [
            { moduleName: 'dsh-tool-foo', declaredName: '.', ok: true },
            { moduleName: 'dsh-tool-foo/bar', declaredName: 'bar', title: 'Bar', ok: true },
            { moduleName: 'dsh-tool-foo/broken', declaredName: 'broken', ok: false, error: 'no default export' },
            { moduleName: 'dsh-tool-foo/silent', declaredName: 'silent', ok: false },
          ],
        }),
        pkg({ name: 'dsh-tool-bare', kind: 'plugin', status: 'plain', addable: [{ moduleName: 'dsh-tool-bare', declaredName: '.', ok: true }] }),
      ],
      presets: [
        preset({ rows: [{ entryId: 'preset:foo', moduleName: 'dsh-tool-foo', source: 'user', enabled: true, fiberPhase: null }] }),
        preset({ id: 'other', name: 'Other', isDefault: false }),
      ],
      globalModules: ['dsh-tool-foo'],
    })
    fireEvent.click(screen.getByRole('button', { name: 'View Foo tools' }))
    expect(screen.getByText(en.statusProblem)).toBeTruthy()
    expect(screen.getByText(`${en.reasonLabel}: one module refused`)).toBeTruthy()
    // The main export reads by the package title; a module by its own title;
    // each names where it is composed, or why it cannot be.
    const moduleText = (name: string): string | undefined => document.querySelector(`[data-plugin-module="${name}"]`)?.textContent
    expect(moduleText('dsh-tool-foo')).toContain(`Foo tools${en.moduleJoined.replace('{targets}', `${en.joinedGlobal}, 标准`)}`)
    expect(moduleText('dsh-tool-foo/bar')).toContain(`Bar${en.moduleNotJoined}`)
    expect(moduleText('dsh-tool-foo/broken')).toContain(en.moduleBroken.replace('{error}', 'no default export'))
    expect(moduleText('dsh-tool-foo/silent')).toContain(en.moduleBroken.replace('{error}', ''))
    // Only an importable module offers Add to…; the menu marks the targets it joined.
    const menus = screen.getAllByRole('button', { name: en.addTo })
    expect(menus).toHaveLength(2)
    fireEvent.click(menus[0] as HTMLElement)
    expect(screen.getByRole('menuitem', { name: en.addToGlobalAdded })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: en.addToPresetAdded.replace('{name}', '标准') })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: en.addToPreset.replace('{name}', 'Other') }))
    expect(actions.addRow).toHaveBeenLastCalledWith('dsh-tool-foo', '.', { kind: 'preset', preset: 'other' })
    fireEvent.click(menus[1] as HTMLElement)
    fireEvent.click(screen.getByRole('menuitem', { name: en.addToGlobal }))
    expect(actions.addRow).toHaveBeenLastCalledWith('dsh-tool-foo', 'bar', { kind: 'global' })
    // The anchor closes its own menu; so does Escape.
    fireEvent.click(menus[1] as HTMLElement)
    fireEvent.click(menus[1] as HTMLElement)
    expect(screen.queryByRole('menuitem', { name: en.addToGlobal })).toBeNull()
    fireEvent.click(menus[1] as HTMLElement)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menuitem', { name: en.addToGlobal })).toBeNull()
    // A package without a title reads by its short name.
    fireEvent.click(screen.getByRole('button', { name: en.backToList }))
    fireEvent.click(screen.getByRole('button', { name: 'View tool-bare' }))
    expect(moduleText('dsh-tool-bare')).toContain(`tool-bare${en.moduleNotJoined}`)
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
