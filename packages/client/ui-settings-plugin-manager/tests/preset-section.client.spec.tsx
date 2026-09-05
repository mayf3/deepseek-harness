// @vitest-environment jsdom
/**
 * The capabilities section of a preset's detail page: rows named through
 * the dictionary or the package manifest, one switch each, delete for the
 * rows the person added, an add menu over what the preset does not carry
 * yet, and the store's read states and notices.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginPackageView } from '@deepseek-ai/dsh-api-remotes/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { PresetPluginsSection } from '../src/client/PresetPluginsSection.tsx'
import type { PresetPluginsSectionProps } from '../src/client/PresetPluginsSection.tsx'
import { rowKey, type PluginManagerState, type PresetGroup } from '../src/client/manager-store.ts'
import { en, type PluginManagerLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

const t = ((key: PluginManagerLocaleKey, params?: Record<string, string>): string =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, value),
    en[key],
  )) as PresetPluginsSectionProps['t']

function pkg(overrides: Partial<PluginPackageView> = {}): PluginPackageView {
  return {
    name: 'dsh-tool-foo',
    version: '0.1.0',
    kind: 'plugin',
    trust: 'external',
    stage: 'runtime',
    installed: true,
    enabled: false,
    status: 'plain',
    cordisSameCopy: true,
    rows: [],
    overrides: [],
    addable: [{ moduleName: 'dsh-tool-foo', declaredName: '.', ok: true }],
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
  globalModules: [],
  busy: [],
  notice: null,
  install: { open: false, spec: '', enable: true, phase: 'idle', log: '', installed: [], enabled: [], installedOnly: [], plain: [], removed: [], failure: null },
  confirm: null,
}

const TARGET = { kind: 'preset', preset: 'standard' } as const

function renderSection(state: Partial<PluginManagerState> = {}, presetId = 'standard') {
  const store = createSnapshotStore<PluginManagerState>({ ...READY, ...state })
  const actions = {
    ensure: vi.fn(),
    addRow: vi.fn(),
    removeRow: vi.fn(),
    setRowDisabled: vi.fn(),
    dismissNotice: vi.fn(),
  }
  const props = {
    t,
    ...actions,
    presetId,
    presetName: '标准',
    usePluginManager: bindSnapshotSelector(store),
  } as unknown as PresetPluginsSectionProps
  render(<PresetPluginsSection {...props} />)
  return { actions, set: (next: Partial<PluginManagerState>) => { act(() => { store.set({ ...store.getSnapshot(), ...next }) }) } }
}

describe('PresetPluginsSection', () => {
  it('asks the store once mounted and renders the read states, a missing preset, and a broken one', () => {
    const { actions, set } = renderSection({ status: 'loading' })
    expect(actions.ensure).toHaveBeenCalledTimes(1)
    expect(screen.getByText(en.loading)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add a capability to 标准' })).toBeNull()

    set({ status: 'unavailable' })
    expect(screen.getByRole('status').textContent).toBe(en.unavailable)

    set({ status: 'error' })
    expect(screen.getByRole('alert').textContent).toBe(en.error)
    expect(screen.getByText(en.presetMissing)).toBeTruthy()

    set({ status: 'ready', presets: [preset({ broken: 'bad yaml' })] })
    expect(screen.getByRole('alert').textContent).toBe('bad yaml')
    expect(screen.queryByText(en.presetMissing)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add a capability to 标准' })).toBeNull()

    set({ presets: [preset()] })
    expect(screen.getByText(en.presetRowsEmpty)).toBeTruthy()
  })

  it('renders the rows as cards with harness names, local marks, switches, and delete for the rows the person added', () => {
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
    const { actions, set } = renderSection({
      packages: [
        pkg({ title: 'Foo tool', description: 'A foo.' }),
        pkg({ name: '@fixture/extra', addable: [] }),
        pkg({ name: 'multi', addable: [{ moduleName: 'multi/a', declaredName: './a', title: 'A tool', ok: true }] }),
      ],
      presets: [preset({ rows })],
    })
    // Harness modules read by their dictionary names: the row id first, then the module.
    expect(screen.getByText(en['name.persona'])).toBeTruthy()
    expect(screen.getByText(en['desc.persona'])).toBeTruthy()
    expect(screen.getByText(en['name.tool-subagent-fork'])).toBeTruthy()
    expect(screen.getByText(en['name.tool-todo'])).toBeTruthy()
    expect(screen.getByText('unknown-thing')).toBeTruthy()
    expect(screen.getByText('@deepseek-ai/dsh-unknown-thing')).toBeTruthy()
    // Installed packages read by their manifest title, an addable module by its own.
    expect(screen.getByText('Foo tool')).toBeTruthy()
    expect(screen.getByText('A foo.')).toBeTruthy()
    expect(screen.getByText('A tool')).toBeTruthy()
    expect(screen.getAllByText(en.localTag)).toHaveLength(5)
    expect(screen.getByText(en.rowStateFailed)).toBeTruthy()
    expect(document.querySelectorAll('[data-preset-row] [data-kind]')).toHaveLength(6)
    expect(screen.getByText(en.rowNoId)).toBeTruthy()
    expect(screen.queryByRole('switch', { name: `Enable ${en['name.tool-todo']}` })).toBeNull()
    expect(screen.getByRole('switch', { name: `Enable ${en['name.tool-pwsh']}` }).getAttribute('aria-checked')).toBe('true')

    fireEvent.click(screen.getByRole('switch', { name: `Enable ${en['name.persona']}` }))
    expect(actions.setRowDisabled).toHaveBeenCalledWith(TARGET, 'persona', true)
    const extra = screen.getByRole('switch', { name: 'Enable extra' })
    expect(extra.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(extra)
    expect(actions.setRowDisabled).toHaveBeenLastCalledWith(TARGET, 'extra', false)
    const gated = screen.getByRole('switch', { name: 'Enable gated' }) as HTMLButtonElement
    expect(gated.disabled).toBe(true)
    expect(gated.title).toBe(en.rowLockedByComposition)
    fireEvent.click(screen.getByRole('button', { name: 'Delete extra from this preset' }))
    expect(actions.removeRow).toHaveBeenCalledWith(TARGET, 'extra')
    expect(screen.queryByRole('button', { name: `Delete ${en['name.persona']} from this preset` })).toBeNull()

    set({ busy: [rowKey(TARGET, 'persona')] })
    expect(screen.getByRole('switch', { name: `Enable ${en['name.persona']}` })).toHaveProperty('disabled', true)
  })

  it('offers to add the installed modules the preset does not carry yet', () => {
    const { actions, set } = renderSection({
      packages: [
        pkg({ title: 'Foo tool' }),
        pkg({
          name: 'multi',
          title: 'Multi',
          addable: [
            { moduleName: 'multi/a', declaredName: './a', title: 'A tool', ok: true },
            { moduleName: 'multi/b', declaredName: './b', ok: true },
            { moduleName: 'multi/c', declaredName: './c', ok: false, error: 'cannot import' },
          ],
        }),
      ],
      presets: [preset({ rows: [{ entryId: 'sub', moduleName: 'multi/a', enabled: true, fiberPhase: null, source: 'user' }] })],
    })
    const add = screen.getByRole('button', { name: 'Add a capability to 标准' })
    fireEvent.click(add)
    // The module the preset carries and the one that cannot import are left out.
    expect(screen.getByRole('menuitem', { name: 'Foo tool' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Multi · ./b' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: 'A tool' })).toBeNull()
    expect(screen.getAllByRole('menuitem')).toHaveLength(2)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Multi · ./b' }))
    expect(actions.addRow).toHaveBeenCalledWith('multi', './b', TARGET)
    expect(screen.queryByRole('menuitem')).toBeNull()

    // Nothing left to add reads as such; an action in flight keeps the menu shut.
    set({ presets: [preset({ rows: [
      { entryId: 'sub', moduleName: 'multi/a', enabled: true, fiberPhase: null, source: 'user' },
      { entryId: 'b', moduleName: 'multi/b', enabled: true, fiberPhase: null, source: 'user' },
      { entryId: 'foo', moduleName: 'dsh-tool-foo', enabled: true, fiberPhase: null, source: 'user' },
    ] })] })
    fireEvent.click(add)
    expect(screen.getByRole('menuitem', { name: en.capabilitiesAddEmpty })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    set({ busy: ['multi'] })
    expect(add).toHaveProperty('disabled', true)
  })

  it('shows the last action\'s outcome and dismisses it', () => {
    const { actions, set } = renderSection({ presets: [preset()], notice: { kind: 'done', packageName: 'x' } })
    expect(screen.getByRole('status').textContent).toContain(en.doneNotice)
    set({ notice: { kind: 'failed', code: 'plugins/row-conflict', reason: 'r', rowId: 'row-1' } })
    expect(screen.getByRole('alert').textContent).toContain(en.rowConflict.replace('{row}', 'row-1'))
    fireEvent.click(screen.getByRole('button', { name: en.dismiss }))
    expect(actions.dismissNotice).toHaveBeenCalledTimes(1)
  })
})
