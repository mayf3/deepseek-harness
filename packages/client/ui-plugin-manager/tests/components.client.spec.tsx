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
    liveReload: true,
    ...overrides,
  }
}

const IDLE_INSTALL: InstallState = {
  open: false, spec: '', phase: 'idle', inputError: null, subject: null, runs: [], detailsOpen: false,
  installed: [], installedOnly: [], plain: [], removed: [], failure: null, enabling: false,
}

const READY: PluginManagerState = {
  status: 'ready',
  packages: [],
  busy: [],
  notice: null,
  install: IDLE_INSTALL,
  confirm: null,
  highlight: null,
}

function renderTab(state: Partial<PluginManagerState> = {}) {
  const store = createSnapshotStore<PluginManagerState>({ ...READY, ...state })
  const actions = {
    ensure: vi.fn(),
    refresh: vi.fn(),
    openInstall: vi.fn(),
    closeInstall: vi.fn(),
    editInstallSpec: vi.fn(),
    runInstall: vi.fn(),
    cancelInstall: vi.fn(),
    toggleInstallDetails: vi.fn(),
    enableInstalled: vi.fn(),
    clearHighlight: vi.fn(),
    setEnabled: vi.fn(),
    retry: vi.fn(),
    uninstall: vi.fn(),
    confirm: vi.fn(),
    cancelConfirm: vi.fn(),
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
    renderTab({ packages: [pkg({ kind: 'unknown', status: 'plain', reason: 'invalid declaration' })] })
    fireEvent.click(screen.getByRole('button', { name: en.pluginsTitle }))
    expect(screen.getByText(en.statusProblem)).toBeTruthy()
  })

  it('lists the installed packages as cards, leaves built-in bundles to Settings, tags only restarts and problems, and names what waits for a restart', () => {
    // A library with no version, as pnpm lists a linked directory.
    const { version: _unversioned, ...someLib } = pkg({ name: 'some-lib', kind: 'unknown', status: 'plain' })
    const { actions } = renderTab({
      packages: [
        pkg({ description: 'A sidebar.' }),
        // The profile template's own bundles and the libraries they carry are not installed by the person: not listed.
        pkg({ name: '@deepseek-ai/dsh-bundle-first-party', title: 'First party', installed: false }),
        pkg({ name: 'unknown', installed: false, kind: 'unknown', status: 'plain' }),
        pkg({ name: 'dsh-untitled', enabled: false, status: 'restart-required', installed: false }),
        pkg({ name: 'broken-bundle', enabled: false, status: 'not-enableable', reason: 'foreign cordis' }),
        pkg({ name: 'dsh-tool-foo', kind: 'unknown', status: 'plain' }),
        someLib,
        pkg({ name: 'pending-bundle', title: 'Pending', enabled: true, status: 'restart-required' }),
        pkg({ name: 'dsh-nameless', enabled: false, status: 'restart-required' }),
        pkg({ name: 'off-bundle', enabled: false, status: 'disabled' }),
      ],
    })
    // The banner names a pack by its title, or by its short name when it has none.
    expect(screen.getByText(en.restartBanner.replace('{names}', 'Pending, nameless'))).toBeTruthy()
    // Packs and plugins list in their own groups; a library counts among the plugins.
    expect(document.querySelector('[data-plugin-group="bundles"] [data-plugin-count]')?.getAttribute('data-plugin-count')).toBe('5')
    expect(document.querySelector('[data-plugin-group="plugins"] [data-plugin-count]')?.getAttribute('data-plugin-count')).toBe('2')
    expect(screen.getByRole('heading', { name: en.bundlesTitle })).toBeTruthy()
    // The dependencies that are not packs stay folded until opened, their count and intro showing meanwhile.
    const plugins = screen.getByRole('button', { name: en.pluginsTitle })
    expect(plugins.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByText(en.pluginsIntro)).toBeTruthy()
    expect(document.querySelector('[data-plugin-package="some-lib"]')).toBeNull()
    fireEvent.click(plugins)
    expect(plugins.getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('[data-plugin-package="some-lib"]')).not.toBeNull()
    for (const name of ['@deepseek-ai/dsh-bundle-first-party', 'unknown', 'dsh-untitled']) {
      expect(document.querySelector(`[data-plugin-package="${name}"]`)).toBeNull()
    }
    // No kind tag, no running or off tag: the switch says that.
    expect(screen.getByText(en.statusProblem)).toBeTruthy()
    expect(screen.getAllByText(en.statusRestart)).toHaveLength(2)
    expect(screen.getByText('A sidebar.')).toBeTruthy()
    expect(document.querySelectorAll('[data-tone]')).toHaveLength(3)

    const sidebar = screen.getByRole('switch', { name: 'Enable better-sidebar' }) as HTMLButtonElement
    expect(sidebar.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(sidebar)
    expect(actions.setEnabled).toHaveBeenCalledWith('dsh-better-sidebar', false)
    expect(screen.getByRole('switch', { name: 'Enable broken-bundle' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('switch', { name: 'Enable off-bundle' }).getAttribute('aria-checked')).toBe('false')
    // A plugin or library has no switch.
    expect(screen.queryByRole('switch', { name: 'Enable tool-foo' })).toBeNull()

    // Uninstall lives on the package's page; a package without a version shows no version fact.
    fireEvent.click(screen.getByRole('button', { name: 'View better-sidebar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall better-sidebar' }))
    expect(actions.uninstall).toHaveBeenCalledWith('dsh-better-sidebar')
    expect(screen.getByText(en.versionLabel)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.backToList }))
    fireEvent.click(screen.getByRole('button', { name: 'View some-lib' }))
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
        pkg({ name: 'dsh-tool-foo', kind: 'unknown', status: 'plain' }),
        pkg({
          name: '@deepseek-ai/dsh-core-broken', title: 'Core', installed: false, status: 'failed',
          rows: [{ entryId: 'include:core', rowId: 'core', moduleName: '@deepseek-ai/dsh-core-broken', enabled: true, phase: 'active' }],
        }),
      ],
    })
    // A failing built-in pack is Settings' business, not this page's: no card, no problem tag for it.
    expect(screen.queryByRole('button', { name: 'View Core' })).toBeNull()
    // A pack whose only trouble is a row waiting for a service is tagged as waiting, not as a problem.
    expect(screen.getByText(en.statusWaiting)).toBeTruthy()
    // The list and its toolbar give way to the page; the crumb leads back.
    fireEvent.click(screen.getByRole('button', { name: 'View better-sidebar' }))
    expect(screen.queryByRole('button', { name: en.addPlugin })).toBeNull()
    expect(screen.getByRole('heading', { name: 'better-sidebar' })).toBeTruthy()
    expect(screen.getByText(`${en.reasonLabel}: one row failed`)).toBeTruthy()
    expect(screen.getByText('0.16.0')).toBeTruthy()
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
    expect(document.querySelector('[data-plugin-modules]')).toBeNull()

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
    // A pack without rows says so; a plugin's page has no rows section.
    fireEvent.click(screen.getByRole('button', { name: 'View no-rows' }))
    expect(screen.getByText(en.partsEmpty)).toBeTruthy()
    expect(screen.getByText(en.noDescription)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.backToList }))
    fireEvent.click(screen.getByRole('button', { name: en.pluginsTitle }))
    fireEvent.click(screen.getByRole('button', { name: 'View tool-foo' }))
    expect(screen.queryByText(en.partsLabel)).toBeNull()
    expect(screen.queryByRole('button', { name: en.retryPackage })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.backToList }))
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
    // applies patches at its next start and a pack that is off. The built-in
    // pack has no page here at all.
    expect(screen.queryByRole('button', { name: 'View Core' })).toBeNull()
    for (const [name, rowId] of [['frozen', 'frozen'], ['parked', 'parked']] as const) {
      fireEvent.click(screen.getByRole('button', { name: `View ${name}` }))
      expect(document.querySelector(`[data-plugin-row="include:${rowId}"]`)?.textContent).toContain(en.partDisabledByUser)
      expect(screen.queryByRole('switch', { name: `Enable component ${rowId}` })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: en.backToList }))
    }
  })

  it('shows a scoped non-bundle package with package details and uninstall', () => {
    renderTab({ packages: [pkg({ name: '@acme/example', kind: 'unknown', status: 'plain' })] })
    fireEvent.click(screen.getByRole('button', { name: en.pluginsTitle }))
    fireEvent.click(screen.getByRole('button', { name: 'View example' }))
    expect(screen.getByText(en.unknownPackage)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Uninstall example' })).toBeTruthy()
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('takes a spec, checks it, and words what the check refused', () => {
    const { actions, set } = renderTab({ install: { ...IDLE_INSTALL, open: true } })
    expect(screen.getByText(en.installDescription)).toBeTruthy()
    const install = () => screen.getByRole('button', { name: en.installRun })
    expect(install()).toHaveProperty('disabled', true)
    const field = screen.getByRole('textbox', { name: en.installSpecLabel })
    fireEvent.change(field, { target: { value: 'dsh-x' } })
    expect(actions.editInstallSpec).toHaveBeenCalledWith('dsh-x')
    expect(document.querySelector('[data-terminal]')).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()

    set({ install: { ...IDLE_INSTALL, open: true, spec: ' dsh-x ' } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: en.installSpecLabel }), { key: 'Enter' })
    fireEvent.click(install())
    expect(actions.runInstall).toHaveBeenCalledTimes(2)
    // The check keeps the field and the button inert.
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'dsh-x', phase: 'checking' } })
    expect(screen.getByRole('textbox', { name: en.installSpecLabel })).toHaveProperty('disabled', true)
    const checking = screen.getByRole('button', { name: en.installChecking })
    expect(checking).toHaveProperty('disabled', true)
    fireEvent.keyDown(screen.getByRole('textbox', { name: en.installSpecLabel }), { key: 'Enter' })
    expect(actions.runInstall).toHaveBeenCalledTimes(2)

    // Each refusal reads under the field.
    const problems: [string, string][] = [
      ['invalid-spec', en.installProblemInvalid.replace('{reason}', 'r')],
      ['already-installed', en.installProblemInstalled],
      ['not-found', en.installProblemNotFound],
      ['not-a-package', en.installProblemNotPackage],
      ['network', en.installProblemNetwork],
      ['unknown', en.installProblemUnknown.replace('{reason}', 'r')],
    ]
    for (const [problem, sentence] of problems) {
      set({ install: { ...IDLE_INSTALL, open: true, spec: 'dsh-x', inputError: { problem: problem as never, reason: 'r' } } })
      expect(screen.getByRole('alert').textContent).toBe(sentence)
      expect(screen.getByRole('textbox', { name: en.installSpecLabel }).getAttribute('aria-invalid')).toBe('true')
    }
    fireEvent.click(screen.getByRole('button', { name: en.close }))
    expect(actions.closeInstall).toHaveBeenCalledTimes(1)
  })

  it('shows the subject while installing, folds the pnpm output behind the details, and stops through the Host', () => {
    const subject = { spec: 'dsh-x', kind: 'registry', name: 'dsh-x', title: 'Sidebar', version: '1.4.2', description: 'A sidebar.', bundle: true } as const
    const run = { jobId: 'j1', command: 'pnpm add dsh-x', cwd: '/home/u/.dsh/profiles/web', output: 'Progress: resolved \u001b[96m1\u001b[39m\n' }
    const { actions, set } = renderTab({ install: { ...IDLE_INSTALL, open: true, spec: 'dsh-x', phase: 'running', subject, runs: [run] } })
    expect(screen.getByRole('status').textContent).toBe(en.installingTitle)
    expect(screen.getByText('Sidebar')).toBeTruthy()
    expect(screen.getByText('A sidebar.')).toBeTruthy()
    expect(screen.getByText(en.installVersion.replace('{version}', '1.4.2'))).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    // The output stays folded until asked for.
    expect(document.querySelector('[data-terminal]')).toBeNull()
    const details = screen.getByRole('button', { name: en.installDetailsShow })
    expect(details.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(details)
    expect(actions.toggleInstallDetails).toHaveBeenCalledTimes(1)
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'dsh-x', phase: 'running', subject, runs: [run], detailsOpen: true } })
    expect(screen.getByRole('button', { name: en.installDetailsHide }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(en.installLocation.replace('{dir}', '/home/u/.dsh/profiles/web'))).toBeTruthy()
    // The run streams as a terminal: its command line, its coloured output so far, the running label.
    expect(screen.getByText('pnpm add dsh-x')).toBeTruthy()
    const terminal = document.querySelector('[data-terminal]') as HTMLElement
    expect(terminal.hasAttribute('data-running')).toBe(true)
    expect(within(terminal).getByText('1').getAttribute('style')).toContain('--dsw-static-blue-500')
    expect(within(terminal).getByText(en.terminalRunning)).toBeTruthy()
    // A long log folds its middle behind an expand control, so the dialog keeps its height while pnpm talks.
    const lines = Array.from({ length: 15 }, (_line, index) => `line ${index + 1}`).join('\n')
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'dsh-x', phase: 'running', subject, detailsOpen: true, runs: [{ ...run, output: `${lines}\n` }] } })
    expect(screen.queryByText('line 8')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.terminalExpandAria.replace('{n}', '3') }))
    expect(screen.getByText('line 8')).toBeTruthy()
    // Before the first chunk there is no location to name.
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'dsh-x', phase: 'running', subject, detailsOpen: true } })
    expect(screen.getByText(en.terminalNoOutput)).toBeTruthy()
    // Cancel and the back control each ask the Host to stop the run; close waits for the Host's word.
    fireEvent.click(screen.getByRole('button', { name: en.installCancel }))
    fireEvent.click(screen.getByRole('button', { name: en.installEditAria }))
    expect(actions.cancelInstall).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: en.close })).toHaveProperty('disabled', true)
    expect(actions.closeInstall).not.toHaveBeenCalled()
  })

  it('waits with the Host through starting, stopping, and applying, and words an unconfirmed stop', () => {
    const subject = { spec: 'slow', kind: 'registry', name: 'slow', bundle: true } as const
    const { actions, set } = renderTab({ install: { ...IDLE_INSTALL, open: true, spec: 'slow', phase: 'starting', subject } })
    // Before the Host acknowledges the run there is nothing to stop: cancel, back, and close all wait.
    expect(screen.getByRole('status').textContent).toBe(en.installStarting)
    expect(screen.getByRole('button', { name: en.installCancel })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: en.installEditAria })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: en.close })).toHaveProperty('disabled', true)
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'slow', phase: 'running', subject } })
    fireEvent.click(screen.getByRole('button', { name: en.installCancel }))
    fireEvent.click(screen.getByRole('button', { name: en.installEditAria }))
    expect(actions.cancelInstall).toHaveBeenCalledTimes(2)
    // While the Host stops the run the terminal reads as cancelled rather than failed.
    set({
      install: {
        ...IDLE_INSTALL, open: true, spec: 'slow', phase: 'cancelling', subject, detailsOpen: true,
        runs: [{ jobId: 'j', command: 'pnpm add slow', cwd: '/p', output: '', exitCode: null }],
      },
    })
    expect(screen.getByRole('status').textContent).toBe(en.installCancelling)
    expect(screen.getByRole('button', { name: en.installCancelling })).toHaveProperty('disabled', true)
    expect(within(document.querySelector('[data-terminal]') as HTMLElement).getByText(en.installCancelledShort)).toBeTruthy()
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'slow', phase: 'applying', subject } })
    expect(screen.getByRole('status').textContent).toBe(en.installApplying)
    expect(screen.getByRole('button', { name: en.installCancel })).toHaveProperty('disabled', true)
    // A stop the Host could not confirm says so over the running screen.
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'slow', phase: 'running', subject, failure: { code: 'client/cancel-unconfirmed', reason: 'offline' } } })
    expect(screen.getByRole('alert').textContent).toContain('offline')
    expect(screen.getByRole('button', { name: en.installCancel })).toHaveProperty('disabled', false)
  })

  it('offers to enable what a finished install added, and words what it did not add', () => {
    const subject = { spec: '/plugins/dsh-x', kind: 'path', name: 'dsh-x', bundle: true } as const
    const { actions, set } = renderTab({
      install: {
        ...IDLE_INSTALL,
        open: true,
        spec: '/plugins/dsh-x',
        phase: 'done',
        subject,
        runs: [{ jobId: 'j1', command: 'pnpm add /plugins/dsh-x', cwd: '/p', output: 'Done in 1s\n', exitCode: 0 }],
        installed: ['dsh-x', 'dsh-lib'],
        installedOnly: ['dsh-x'],
        plain: ['dsh-lib'],
        removed: [
          { name: 'invalid-bundle', reason: 'invalid stage' },
          { name: 'clash', reason: 'row "x" is already declared by y' },
        ],
      },
    })
    expect(screen.getByText(en.installedTitle)).toBeTruthy()
    // A path without a description reads by its kind.
    expect(screen.getByText('dsh-x')).toBeTruthy()
    expect(screen.getByText(en.installSubjectPath)).toBeTruthy()
    expect(screen.getByText(en.installDoneNotBundle.replace('{name}', 'dsh-lib'))).toBeTruthy()
    expect(screen.getByText(en.installRemovedInvalid.replace('{name}', 'invalid-bundle').replace('{reason}', 'invalid stage'))).toBeTruthy()
    expect(screen.getByText(en.installRemovedConflict.replace('{name}', 'clash').replace('{reason}', 'row "x" is already declared by y'))).toBeTruthy()
    // No way back to the spec from here; enabling is the one action.
    expect(screen.queryByRole('button', { name: en.installEditAria })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.installEnableNow }))
    expect(actions.enableInstalled).toHaveBeenCalledTimes(1)
    set({ install: { ...IDLE_INSTALL, open: true, spec: '/plugins/dsh-x', phase: 'done', subject, installed: ['dsh-x'], installedOnly: ['dsh-x'], enabling: true } })
    expect(screen.getByRole('button', { name: en.installEnableNow })).toHaveProperty('disabled', true)

    // Nothing new, or nothing that switches on, leaves only Done.
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'dsh-x', phase: 'done', subject: { spec: 'dsh-x', kind: 'registry', name: 'dsh-x', bundle: false } } })
    expect(screen.getByText(en.installDoneNothing)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.installEnableNow })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.installClose }))
    expect(actions.closeInstall).toHaveBeenCalledTimes(1)
  })

  it('words a failed install by its kind and retries it', () => {
    const subject = { spec: 'github:a/b', kind: 'git', bundle: null } as const
    const { actions, set } = renderTab({
      install: {
        ...IDLE_INSTALL,
        open: true,
        spec: 'github:a/b',
        phase: 'failed',
        subject,
        detailsOpen: true,
        runs: [{ jobId: 'j1', command: 'pnpm add github:a/b', cwd: '/p', output: 'ERR\n', exitCode: 1 }],
        failure: { code: 'plugins/install-failed', reason: 'ERR\n', kind: 'network' },
      },
    })
    expect(screen.getByRole('alert').textContent).toBe(en.installFailedTitle)
    expect(screen.getByText(en.installFailureNetwork)).toBeTruthy()
    // A git spec without a manifest reads by its address and kind.
    expect(screen.getByText('github:a/b')).toBeTruthy()
    expect(screen.getByText(en.installSubjectGit)).toBeTruthy()
    expect(screen.getByText(en.terminalExitCode.replace('{code}', '1'))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.installRetry }))
    expect(actions.runInstall).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: en.installEditAria }))
    expect(actions.cancelInstall).toHaveBeenCalledTimes(1)

    const kinds: [string, string][] = [
      ['pnpm-missing', en.installFailurePnpmMissing], ['timeout', en.installFailureTimeout],
      ['not-found', en.installFailureNotFound], ['no-matching-version', en.installFailureNoMatchingVersion],
      ['disk-full', en.installFailureDiskFull], ['permission', en.installFailurePermission],
      ['build-blocked', en.installFailureBuildBlocked], ['integrity', en.installFailureIntegrity], ['unknown', en.installFailureGeneric],
    ]
    for (const [kind, sentence] of kinds) {
      set({ install: { ...IDLE_INSTALL, open: true, spec: 'x', phase: 'failed', failure: { code: 'plugins/install-failed', reason: 'r', kind: kind as never } } })
      expect(screen.getByText(sentence)).toBeTruthy()
    }
    // A pnpm failure without a kind, a refusal, and no failure at all.
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'x', phase: 'failed', failure: { code: 'plugins/install-failed', reason: 'r' } } })
    expect(screen.getByText(en.installFailureGeneric)).toBeTruthy()
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'x', phase: 'failed', failure: { code: 'plugins/enable-failed', reason: 'r' } } })
    expect(screen.getByText(en.actionFailed.replace('{reason}', 'r'))).toBeTruthy()
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'x', phase: 'failed', failure: null } })
    expect(screen.getByText(en.installFailureGeneric)).toBeTruthy()
  })

  it('scrolls to and marks the package an install enabled, then lets the mark go', () => {
    vi.useFakeTimers()
    const scrollIntoView = vi.fn()
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
    Object.defineProperty(Element.prototype, 'scrollIntoView', { value: scrollIntoView, configurable: true })
    try {
      const { actions, set } = renderTab({ packages: [pkg()] })
      // A package the list does not show has nothing to scroll to; the mark still times out.
      set({ highlight: 'missing' })
      expect(scrollIntoView).not.toHaveBeenCalled()
      act(() => { vi.advanceTimersByTime(2_400) })
      expect(actions.clearHighlight).toHaveBeenCalledTimes(1)
      set({ highlight: 'dsh-better-sidebar' })
      expect(document.querySelector('[data-plugin-package="dsh-better-sidebar"]')?.hasAttribute('data-plugin-highlight')).toBe(true)
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' })
      act(() => { vi.advanceTimersByTime(2_400) })
      expect(actions.clearHighlight).toHaveBeenCalledTimes(2)
      set({ highlight: null })
      expect(document.querySelector('[data-plugin-package="dsh-better-sidebar"]')?.hasAttribute('data-plugin-highlight')).toBe(false)
    } finally {
      if (descriptor === undefined) delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
      else Object.defineProperty(Element.prototype, 'scrollIntoView', descriptor)
      vi.useRealTimers()
    }
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

  it('words every notice as a toast that dismisses itself', () => {
    vi.useFakeTimers()
    try {
      const { actions, set } = renderTab({ notice: { kind: 'restart', packageName: 'x', seq: 1 } })
      expect(screen.getByRole('alert').textContent).toContain(en.restartNotice)
      const failures: [string, string][] = [
        ['plugins/not-enableable', en.notEnableable.replace('{reason}', 'r')],
        ['plugins/enable-failed', en.enableFailed.replace('{reason}', 'r')],
        ['plugins/not-installed', en.notInstalled.replace('{name}', 'pkg-1')],
        ['plugins/busy', en.busy.replace('{reason}', 'r')],
        ['plugins/agents-running', en.agentsRunning.replace('{reason}', 'r')],
        ['plugins/install-failed', en.installFailed],
        ['gateway/internal', en.actionFailed.replace('{reason}', 'r')],
      ]
      let seq = 1
      for (const [code, text] of failures) {
        set({ notice: { kind: 'failed', code, reason: 'r', packageName: 'pkg-1', rowId: 'row-1', seq: ++seq } })
        expect(screen.getByRole('alert').textContent).toContain(text)
      }
      set({ notice: { kind: 'cancelled', seq: ++seq } })
      expect(screen.getByRole('alert').textContent).toContain(en.installCancelled)
      set({ notice: { kind: 'failed', code: 'plugins/not-installed', reason: 'r', seq: ++seq } })
      expect(screen.getByRole('alert').textContent).toContain(en.notInstalled.replace('{name}', ''))
      // No button to press: the toast retires on its own and the store forgets it.
      expect(screen.queryByRole('button', { name: /got it/i })).toBeNull()
      expect(actions.dismissNotice).not.toHaveBeenCalled()
      // The hold grows with the text, up to eight seconds, then the fade.
      act(() => { vi.advanceTimersByTime(8_000 + 1_000) })
      expect(actions.dismissNotice).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
