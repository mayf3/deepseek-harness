// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginPackageView } from '@deepseek-ai/dsh-api-remotes/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { PluginManagerPage } from '../src/client/PluginManagerPage.tsx'
import type { PluginManagerPageProps } from '../src/client/PluginManagerPage.tsx'
import { rowKey, type InstallState, type PluginManagerState } from '../src/client/manager-store.ts'
import { en, type PluginManagerLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

const t = ((key: PluginManagerLocaleKey, params?: Record<string, string>): string =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, value),
    en[key],
  )) as PluginManagerPageProps['t']

function pkg(overrides: Partial<PluginPackageView> = {}): PluginPackageView {
  return {
    name: 'dsh-better-sidebar',
    version: '0.16.0',
    kind: 'bundle',
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

const IDLE_INSTALL: InstallState = {
  open: false, spec: '', enable: true, phase: 'idle', runs: [], installed: [], enabled: [], installedOnly: [], plain: [], removed: [], failure: null,
}

const READY: PluginManagerState = {
  status: 'ready',
  packages: [],
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
    disableRow: vi.fn(),
    dismissNotice: vi.fn(),
  }
  const props = {
    t,
    ...actions,
    usePluginManager: bindSnapshotSelector(store),
  } as unknown as PluginManagerPageProps
  render(<PluginManagerPage {...props} />)
  return { store, actions, set: (next: Partial<PluginManagerState>) => { act(() => { store.set({ ...store.getSnapshot(), ...next }) }) } }
}

describe('PluginManagerPage', () => {
  it('keeps a non-dependency override failure visible even when owned rows are waiting', () => {
    renderTab({ packages: [pkg({
      name: 'overrides', title: 'Overrides', enabled: true, status: 'partial',
      rows: [{ entryId: 'wait', rowId: 'wait', moduleName: 'overrides', enabled: true, phase: 'pending' }],
      issues: [{ entryId: 'include:core', moduleName: 'core', stage: 'update', message: 'Rejected config' }],
    })] })
    expect(screen.getByText(en.statusProblem)).toBeTruthy()
    expect(screen.queryByText(en.statusWaiting)).toBeNull()
  })

  it('shows an active old instance with its failed update and identifies affected external rows', () => {
    const { set } = renderTab({ packages: [pkg({
      name: 'updates', title: 'Updates', enabled: true, status: 'partial',
      rows: [{ entryId: 'include:own', rowId: 'own', moduleName: 'updates', enabled: true, phase: 'active', failure: { stage: 'update', message: 'Invalid updated config' } }],
      issues: [
        { entryId: 'include:own', moduleName: 'updates', stage: 'update', message: 'Invalid updated config' },
        { entryId: 'include:webserver', moduleName: 'webserver', stage: 'update', message: 'Invalid port' },
      ],
    })] })
    fireEvent.click(screen.getByRole('button', { name: 'View Updates' }))
    expect(screen.getByText(en.rowUpdateFailed)).toBeTruthy()
    expect(screen.getByText('Invalid updated config')).toBeTruthy()
    expect(screen.getByText('include:webserver')).toBeTruthy()
    expect(screen.getByText('Invalid port')).toBeTruthy()
    expect(screen.getByText(en.partsCountRunning.replace('{count}', '1'), { exact: false })).toBeTruthy()
    expect(screen.getByText(en.partsCountUpdateFailed.replace('{count}', '1'), { exact: false })).toBeTruthy()
    set({ packages: [pkg({ name: 'updates', title: 'Updates', kind: 'unknown', status: 'plain', rows: [] })] })
    expect(screen.getByText(en.unknownPackage)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.uninstallLabel.replace('{name}', 'Updates') })).toBeTruthy()
  })

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

  it('shows a problem for a plugin with an invalid declaration', () => {
    renderTab({ packages: [pkg({ kind: 'plugin', status: 'plain', reason: 'invalid declaration' })] })
    expect(screen.getByText(en.statusProblem)).toBeTruthy()
  })

  it('lists every package as a card, tags only restarts, problems, and built-ins, and names what waits for a restart', () => {
    const { version: _unversioned, ...bundledPackage } = pkg({
      name: '@deepseek-ai/dsh-bundle-first-party', title: 'First party', installed: false,
    })
    const { actions } = renderTab({
      packages: [
        pkg({ description: 'A sidebar.' }),
        bundledPackage,
        pkg({ name: 'unknown', installed: false, kind: 'plugin', status: 'plain' }),
        pkg({ name: 'builtin-lib', installed: false, kind: 'unknown', status: 'plain' }),
        pkg({ name: 'broken-bundle', enabled: false, status: 'not-enableable', reason: 'foreign cordis' }),
        pkg({ name: 'dsh-tool-foo', kind: 'plugin', status: 'plain' }),
        pkg({ name: 'some-lib', kind: 'unknown', status: 'plain' }),
        pkg({ name: 'pending-bundle', title: 'Pending', enabled: true, status: 'restart-required' }),
        pkg({ name: 'dsh-untitled', enabled: false, status: 'restart-required', installed: false }),
        pkg({ name: 'off-bundle', enabled: false, status: 'disabled' }),
      ],
    })
    expect(screen.getByText(en.restartBanner.replace('{names}', 'Pending, untitled'))).toBeTruthy()
    // Packs and plugins list in their own groups; a library counts among the plugins.
    expect(document.querySelector('[data-plugin-group="bundles"] [data-plugin-count]')?.getAttribute('data-plugin-count')).toBe('6')
    expect(document.querySelector('[data-plugin-group="plugins"] [data-plugin-count]')?.getAttribute('data-plugin-count')).toBe('4')
    expect(screen.getByRole('heading', { name: en.bundlesTitle })).toBeTruthy()
    expect(screen.getByRole('heading', { name: en.pluginsTitle })).toBeTruthy()
    // No kind tag, no running or off tag: the switch says that.
    expect(screen.getByText(en.statusProblem)).toBeTruthy()
    expect(screen.getAllByText(en.statusRestart)).toHaveLength(2)
    expect(screen.getAllByText(en.builtinTag)).toHaveLength(4)
    expect(screen.getByText('A sidebar.')).toBeTruthy()
    expect(document.querySelectorAll('[data-tone]')).toHaveLength(7)

    const sidebar = screen.getByRole('switch', { name: 'Enable better-sidebar' }) as HTMLButtonElement
    expect(sidebar.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(sidebar)
    expect(actions.setEnabled).toHaveBeenCalledWith('dsh-better-sidebar', false)
    expect(screen.getByRole('switch', { name: 'Enable broken-bundle' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('switch', { name: 'Enable off-bundle' }).getAttribute('aria-checked')).toBe('false')
    // A built-in pack keeps a locked switch in the same list; a built-in plugin or library has none.
    const bundled = screen.getByRole('switch', { name: 'Enable First party' }) as HTMLButtonElement
    expect(bundled.disabled).toBe(true)
    expect(bundled.title).toBe(en.builtinLocked)
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
            { entryId: 'include:wait', rowId: 'wait', moduleName: 'dsh-better-sidebar/wait', enabled: true, phase: 'pending' },
            { entryId: 'include:recorded', rowId: 'recorded', moduleName: 'dsh-better-sidebar/recorded', enabled: true, phase: null, failure: { stage: 'inject-pending', message: 'pending (waiting for service: authorization)' } },
            { entryId: 'include:healed', rowId: 'healed', moduleName: 'dsh-better-sidebar/healed', enabled: true, phase: 'active', failure: { stage: 'inject-pending', message: 'stale' } },
          ],
        }),
        pkg({
          name: 'waiting-pack', status: 'partial', reason: 'pending (waiting for service: authorization)',
          rows: [{ entryId: 'include:w1', rowId: 'w1', moduleName: 'waiting-pack', enabled: true, phase: null, failure: { stage: 'inject-pending', message: 'pending (waiting for service: authorization)' } }],
        }),
        pkg({ name: 'no-rows', enabled: false, status: 'disabled' }),
        pkg({ name: 'dsh-tool-foo', kind: 'plugin', status: 'plain' }),
        pkg({
          name: '@deepseek-ai/dsh-core-broken', title: 'Core', installed: false, status: 'failed',
          rows: [{ entryId: 'include:core', rowId: 'core', moduleName: '@deepseek-ai/dsh-core-broken', enabled: true, phase: 'active' }],
        }),
      ],
    })
    // A pack whose only trouble is a row waiting for a service is tagged as waiting, not as a problem.
    expect(screen.getByText(en.statusWaiting)).toBeTruthy()
    // The list and its toolbar give way to the page; the crumb leads back.
    fireEvent.click(screen.getByRole('button', { name: 'View better-sidebar' }))
    expect(screen.queryByRole('button', { name: en.addPlugin })).toBeNull()
    expect(screen.getByRole('heading', { name: 'better-sidebar' })).toBeTruthy()
    expect(screen.getByText(`${en.reasonLabel}: one row failed`)).toBeTruthy()
    expect(screen.getByText('0.16.0')).toBeTruthy()
    expect(screen.getByText(en.sourceExternal)).toBeTruthy()
    // Every row in the pack's order: its id over the module it loads, then its state; a failure adds its message.
    expect(screen.getByText('9 total · 2 running · 2 waiting · 2 off · 2 failed')).toBeTruthy()
    const rowText = (id: string): string | undefined => document.querySelector(`[data-plugin-row="include:${id}"]`)?.textContent
    expect(rowText('better-sidebar')).toBe(`better-sidebardsh-better-sidebar${en.rowPhaseActive}`)
    expect(rowText('off')).toBe(`offdsh-better-sidebar/off${en.partDisabledByUser}`)
    expect(rowText('gated')).toBe(`gateddsh-better-sidebar/gated${en.partDisabledByComposition}`)
    expect(rowText('crash')).toBe(`crashdsh-better-sidebar/crash${en.rowStateFailed}boom`)
    expect(rowText('flaky')).toBe(`flakydsh-better-sidebar/flaky${en.rowStateFailed}`)
    expect(rowText('idle')).toBe(`idledsh-better-sidebar/idle${en.rowStateIdle}`)
    // A wait for a service reads the same whether the fiber is pending or a composition recorded the wait.
    expect(rowText('wait')).toBe(`waitdsh-better-sidebar/wait${en.rowPhasePending}`)
    expect(rowText('recorded')).toBe(`recordeddsh-better-sidebar/recorded${en.rowPhasePending}pending (waiting for service: authorization)`)
    expect(document.querySelector('[data-plugin-row="include:wait"]')?.getAttribute('data-state')).toBe('waiting')
    expect(document.querySelector('[data-plugin-row="include:recorded"]')?.getAttribute('data-state')).toBe('waiting')
    // A row that came to life is running, whatever record the registry still holds for it.
    expect(rowText('healed')).toBe(`healeddsh-better-sidebar/healed${en.rowPhaseActive}`)
    expect(document.querySelector('[data-plugin-row="include:healed"]')?.getAttribute('data-state')).toBeNull()
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

    // The waiting pack's page keeps the wait on its row and repeats no reason above the facts.
    fireEvent.click(screen.getByRole('button', { name: 'View waiting-pack' }))
    expect(screen.queryByText(`${en.reasonLabel}: pending (waiting for service: authorization)`)).toBeNull()
    expect(screen.getByText('1 total · 1 waiting')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.backToList }))
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
        pkg({ name: '@deepseek-ai/dsh-core', title: 'Core', installed: false, rows: [{ entryId: 'include:core', rowId: 'core', moduleName: '@deepseek-ai/dsh-core', ...userOff }] }),
      ],
    })
    fireEvent.click(screen.getByRole('button', { name: 'View better-sidebar' }))
    // A row the person switched off switches back on at once; one the pack itself keeps off is locked and says why.
    const off = screen.getByRole('switch', { name: 'Enable component off' })
    expect(off.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(off)
    expect(actions.setRowDisabled).toHaveBeenLastCalledWith('off', false)
    expect(actions.disableRow).not.toHaveBeenCalled()
    const gated = screen.getByRole('switch', { name: 'Enable component gated' })
    expect(gated).toHaveProperty('disabled', true)
    expect(gated.getAttribute('title')).toBe(en.partLockedByComposition)
    // Switching a row off goes through the ask, which names the package and the row's tree-wide id;
    // a failing row can be switched off; a row another layer owns has nothing mounted to switch.
    fireEvent.click(screen.getByRole('switch', { name: 'Enable component crash' }))
    expect(actions.disableRow).toHaveBeenLastCalledWith('dsh-better-sidebar', 'include:crash', 'crash')
    expect(screen.queryByRole('switch', { name: 'Enable component taken' })).toBeNull()
    const sidebar = screen.getByRole('switch', { name: 'Enable component better-sidebar' })
    expect(sidebar.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(sidebar)
    expect(actions.disableRow).toHaveBeenLastCalledWith('dsh-better-sidebar', 'include:better-sidebar', 'better-sidebar')
    expect(actions.setRowDisabled).toHaveBeenCalledTimes(1)
    // Only the row with a write in flight goes inert; a busy package takes every row with it.
    set({ busy: [rowKey('better-sidebar')] })
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
      expect(document.querySelector(`[data-plugin-row="include:${rowId}"]`)?.textContent).toContain(en.partDisabledByUser)
      expect(screen.queryByRole('switch', { name: `Enable component ${rowId}` })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: en.backToList }))
    }
  })

  it('adds a declared module globally and disables the action once it is present', () => {
    const mod = { moduleName: 'example/search', declaredName: './search', title: 'Search' }
    const { actions, set } = renderTab({ packages: [pkg({ name: 'example', kind: 'plugin', status: 'plain', addable: [mod] })] })
    fireEvent.click(screen.getByRole('button', { name: en.addToGlobal }))
    expect(actions.addRow).toHaveBeenCalledWith('example', './search')
    set({ globalModules: ['example/search'] })
    expect(screen.getByRole('button', { name: en.addToGlobalAdded })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: en.openDetail.replace('{name}', 'example') }))
    expect(screen.getByText(en.joinedGlobal)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.addToGlobalAdded })).toHaveProperty('disabled', true)
  })

  it('selects among multiple declared modules and adds one directly to the global layer', () => {
    const { actions } = renderTab({ packages: [pkg({ name: 'example', kind: 'plugin', status: 'plain', addable: [
      { moduleName: 'example/search', declaredName: './search', title: 'Search' },
      { moduleName: 'example/fetch', declaredName: './fetch', title: 'Fetch' },
    ] })] })
    fireEvent.click(screen.getByRole('button', { name: en.addToGlobal }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Fetch' }))
    expect(actions.addRow).toHaveBeenCalledWith('example', './fetch')
  })

  it('adds untitled main and subpath modules from a package detail page', () => {
    const { actions, set } = renderTab({ packages: [pkg({ name: '@fixture/modules', kind: 'plugin', status: 'plain', addable: [
      { moduleName: '@fixture/modules', declaredName: '.' },
      { moduleName: '@fixture/modules/search', declaredName: './search' },
    ] })] })
    fireEvent.click(screen.getByRole('button', { name: en.addToGlobal }))
    expect(screen.getByRole('menuitem', { name: './search' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.openDetail.replace('{name}', 'modules') }))
    const buttons = screen.getAllByRole('button', { name: en.addToGlobal })
    fireEvent.click(buttons[1]!)
    expect(actions.addRow).toHaveBeenCalledWith('@fixture/modules', './search')
    set({ busy: ['@fixture/modules'] })
    expect(screen.getAllByRole('button', { name: en.addToGlobal }).every(button => (button as HTMLButtonElement).disabled)).toBe(true)
  })

  it('drives the install dialog through its phases and words each outcome', () => {
    const { actions, set } = renderTab({ install: { ...IDLE_INSTALL, open: true } })
    expect(screen.getByText(en.installExample)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.installRun })).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByRole('textbox', { name: en.installSpecLabel }), { target: { value: 'dsh-x' } })
    expect(actions.editInstallSpec).toHaveBeenCalledWith('dsh-x')
    fireEvent.click(screen.getByRole('checkbox'))
    expect(actions.toggleInstallEnable).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-terminal]')).toBeNull()

    set({ install: { ...IDLE_INSTALL, open: true, spec: ' dsh-x ' } })
    fireEvent.click(screen.getByRole('button', { name: en.installRun }))
    expect(actions.runInstall).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    expect(actions.closeInstall).toHaveBeenCalledTimes(1)

    set({
      install: {
        ...IDLE_INSTALL,
        open: true,
        spec: 'dsh-x',
        phase: 'running',
        runs: [{ jobId: 'j1', command: 'pnpm add dsh-x', cwd: '/home/u/.dsh/profiles/web', output: 'Progress: resolved \u001b[96m1\u001b[39m\n' }],
      },
    })
    expect(screen.getByText(en.installRunning.replace('{spec}', 'dsh-x'))).toBeTruthy()
    expect(screen.getByText(en.installLocation.replace('{dir}', '/home/u/.dsh/profiles/web'))).toBeTruthy()
    // The run streams as a terminal: its command line, its coloured output so far, the running label.
    expect(screen.getByText('pnpm add dsh-x')).toBeTruthy()
    const terminal = document.querySelector('[data-terminal]') as HTMLElement
    expect(terminal.hasAttribute('data-running')).toBe(true)
    expect(within(terminal).getByText('1').getAttribute('style')).toContain('--dsw-static-blue-500')
    expect(within(terminal).getByText(en.terminalRunning)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.installRun })).toHaveProperty('disabled', true)
    // A long log folds its middle behind an expand control, so the dialog keeps its height while pnpm talks.
    const lines = Array.from({ length: 15 }, (_line, index) => `line ${index + 1}`).join('\n')
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'dsh-x', phase: 'running', runs: [{ jobId: 'j1', command: 'pnpm add dsh-x', cwd: '/p', output: `${lines}\n` }] } })
    expect(screen.queryByText('line 8')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.terminalExpandAria.replace('{n}', '3') }))
    expect(screen.getByText('line 8')).toBeTruthy()
    expect(screen.getByText(en.terminalCollapse)).toBeTruthy()

    set({
      install: {
        ...IDLE_INSTALL,
        open: true,
        spec: 'dsh-x',
        phase: 'done',
        runs: [{ jobId: 'j1', command: 'pnpm add dsh-x', cwd: '/p', output: 'Done in 1s\n', exitCode: 0 }],
        installed: ['a', 'b', 'c', 'd'],
        enabled: ['a'],
        installedOnly: ['b'],
        plain: ['c'],
        removed: [
          { name: 'invalid-bundle', reason: 'invalid stage' },
          { name: 'clash', reason: 'row "x" is already declared by y' },
        ],
      },
    })
    expect(screen.getByText(en.installDoneEnabled.replace('{name}', 'a'))).toBeTruthy()
    expect(screen.getByText(en.installDoneBundle.replace('{name}', 'b'))).toBeTruthy()
    expect(screen.getByText(en.installDonePlugin.replace('{name}', 'c'))).toBeTruthy()
    expect(screen.getByText(en.installDoneOther.replace('{name}', 'd'))).toBeTruthy()
    expect(screen.getByText(en.installRemovedInvalid.replace('{name}', 'invalid-bundle').replace('{reason}', 'invalid stage'))).toBeTruthy()
    expect(screen.getByText(en.installRemovedConflict.replace('{name}', 'clash').replace('{reason}', 'row "x" is already declared by y'))).toBeTruthy()
    // A finished run leaves Done as the only action.
    expect(screen.getByRole('button', { name: en.installClose })).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.installRun })).toBeNull()
    expect(within(document.querySelector('[data-terminal]') as HTMLElement).getByText(en.terminalDone)).toBeTruthy()

    set({ install: { ...IDLE_INSTALL, open: true, spec: 'dsh-x', phase: 'done' } })
    expect(screen.getByText(en.installDoneNothing)).toBeTruthy()

    // A pnpm failure with its run on screen points at the terminal; without a run, the Host's tail stands in.
    set({
      install: {
        ...IDLE_INSTALL,
        open: true,
        spec: 'dsh-x',
        phase: 'failed',
        runs: [{ jobId: 'j1', command: 'pnpm add dsh-x', cwd: '/p', output: 'ERR\n', exitCode: 1 }],
        failure: { code: 'plugins/install-failed', reason: 'ERR\n' },
      },
    })
    expect(screen.getByRole('alert').textContent).toBe(en.installFailed)
    expect(screen.getByRole('button', { name: en.installRetry })).toBeTruthy()
    expect(screen.getByText(en.terminalExitCode.replace('{code}', '1'))).toBeTruthy()
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'dsh-x', phase: 'failed', failure: { code: 'plugins/install-failed', reason: 'ERR' } } })
    expect(screen.getByRole('alert').textContent).toBe(en.installFailedTail.replace('{reason}', 'ERR'))
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'dsh-x', phase: 'failed', failure: { code: 'plugins/busy', reason: 'add x' } } })
    expect(screen.getByRole('alert').textContent).toBe(en.busy.replace('{reason}', 'add x'))
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'dsh-x', phase: 'failed', failure: null } })
    expect(screen.getByRole('alert').textContent).toBe(en.installFailed)
  })

  it('asks before switching a row off, naming the rows that inject what it provides', () => {
    const { actions } = renderTab({
      packages: [pkg()],
      confirm: {
        action: 'disableRow', packageName: 'dsh-better-sidebar', rowId: 'seam',
        dependents: { services: [{ service: 'authorization', providedBy: 'include:seam', injectedBy: ['include:oauth'] }], references: [] },
      },
    })
    expect(screen.getByRole('dialog', { name: en.confirmDisableRowTitle.replace('{name}', 'seam') })).toBeTruthy()
    expect(screen.getByText(en.confirmDisableRowDescription)).toBeTruthy()
    expect(screen.getByText(en.confirmDependents)).toBeTruthy()
    expect(within(screen.getByRole('dialog')).getByRole('listitem').textContent).toContain('oauth')
    fireEvent.click(screen.getByRole('button', { name: en.confirmDisableRow }))
    expect(actions.confirm).toHaveBeenCalledTimes(1)
  })

  it('names what still uses a package in the confirmation and runs the action through it', () => {
    const { actions, set } = renderTab({
      packages: [pkg(), pkg({ name: 'dsh-other', title: 'Other' })],
      confirm: { action: 'uninstall', packageName: 'dsh-better-sidebar', dependents: undefined },
    })
    // An uninstall is always confirmed, so its dialog opens while the Host is still asked.
    expect(screen.getByRole('dialog', { name: en.confirmUninstallTitle.replace('{name}', 'better-sidebar') })).toBeTruthy()
    expect(screen.getByText(en.confirmChecking)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.confirmUninstall })).toHaveProperty('disabled', true)

    set({
      confirm: {
        action: 'disable',
        packageName: 'dsh-better-sidebar',
        dependents: {
          services: [{ service: 'sidebar', providedBy: 'include:sidebar', injectedBy: ['include:tool-bash', 'include:custom'] }],
          references: [
            { rowId: 'r1', moduleName: 'dsh-other/x' },
            { rowId: 'r2', moduleName: '@fixture/other' },
            { rowId: 'r3', moduleName: 'dsh-better-sidebar' },
          ],
        },
      },
    })
    expect(screen.getByText(en.dependentService.replace('{rows}', `${en['name.tool-bash']}, custom`))).toBeTruthy()
    expect(screen.getByText(en.dependentReferenceGlobal.replace('{row}', 'Other'))).toBeTruthy()
    expect(screen.getByText(en.dependentReferenceGlobal.replace('{row}', 'r2'))).toBeTruthy()
    expect(screen.getByText(en.dependentReferenceGlobal.replace('{row}', 'better-sidebar'))).toBeTruthy()
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
