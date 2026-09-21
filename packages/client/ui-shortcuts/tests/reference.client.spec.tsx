// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ShortcutCatalogEntry, ShortcutCommandId, ShortcutFixedCatalogEntry } from '@deepseek-ai/dsh-client-shortcuts/client'
import { ShortcutReference, ShortcutsRow } from '../src/client/Reference.tsx'
import { createShortcutsStore } from '../src/client/store.ts'
import { en, zh } from '../src/client/locales.ts'
import { initialShortcutConfig, bindingIssue, bindingKey, normalizeBinding, presentBinding } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import type { ShortcutConfigSnapshot } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import { apply as hostApply } from '../src/index.ts'

const describeBinding: Parameters<typeof ShortcutReference>[0]['describeBinding'] = (binding) => {
  const normalized = binding === null ? null : normalizeBinding(binding, 'macos')
  return { binding: normalized, index: normalized === null ? null : bindingKey(normalized), keys: presentBinding(normalized, 'macos').keys,
    issue: normalized === null ? null : bindingIssue(normalized, 'web', 'macos'), conflicts: [] }
}
afterEach(cleanup)
it.each(['macos', 'windows'] as const)('shows the reference, filters labels and keys, and clears its query on close (%s)', (platform) => {
  hostApply()
  const store = createShortcutsStore().create()
  const catalog = createSnapshotStore<readonly ShortcutCatalogEntry[]>([
    { id: 'shortcuts.open' as ShortcutCommandId, label: 'Open shortcuts', aliases: ['shortcuts'], binding: { code: 'Slash', modifiers: [platform === 'macos' ? 'meta' : 'control'] }, modified: false, conflicts: [], issue: null, unavailableReason: null,
      keys: platform === 'macos' ? ['⌘', '/'] : ['Ctrl', '+', '/'], aria: platform === 'macos' ? 'Meta+/' : 'Control+/' },
    { id: 'settings.open' as ShortcutCommandId, label: 'Open settings', aliases: ['preferences'], binding: null, modified: false, conflicts: [], issue: null, unavailableReason: null, keys: [], aria: undefined },
    { id: 'sidebar.left.toggle' as ShortcutCommandId, label: 'Toggle left sidebar', aliases: ['sidebar', 'toggle left sidebar'],
      binding: { code: 'KeyB', modifiers: [platform === 'macos' ? 'meta' : 'control'] }, modified: false, conflicts: [], issue: null, unavailableReason: null,
      keys: platform === 'macos' ? ['⌘', 'B'] : ['Ctrl', '+', 'B'], aria: platform === 'macos' ? 'Meta+B' : 'Control+B' },
  ])
  const config = createSnapshotStore({ ...initialShortcutConfig(), status: 'ready' as const })
  const props = { actions: store.actions, useStore: bindSnapshotSelector(store), useCatalog: bindSnapshotSelector(catalog),
    useConfig: bindSnapshotSelector(config), useFixedCatalog: bindSnapshotSelector(createSnapshotStore([])), runtime: 'web', edit: async () => ({ status: 'saved', snapshot: config.getSnapshot() }), recording: async () => {},
    describeBinding: (binding: Parameters<typeof describeBinding>[0]) => {
      const normalized = binding === null ? null : normalizeBinding(binding, platform)
      return { ...describeBinding(binding), keys: presentBinding(normalized, platform).keys }
    }, platform, t: makeTranslate(en) } as unknown as Parameters<typeof ShortcutReference>[0]
  render(<><ShortcutsRow {...props} /><ShortcutReference {...props} /></>)
  expect(screen.queryByRole('dialog')).toBeNull()
  const opener = screen.getByRole('button', { name: 'View shortcuts' }); opener.focus(); fireEvent.click(opener)
  expect(opener.getAttribute('aria-keyshortcuts')).toBe(platform === 'macos' ? 'Meta+/' : 'Control+/')
  const search = screen.getByRole('searchbox')
  expect(document.activeElement).toBe(search)
  expect(screen.getByText('No shortcut')).toBeTruthy()
  fireEvent.change(search, { target: { value: 'preferences' } })
  expect(screen.getAllByRole('listitem')).toHaveLength(1)
  fireEvent.change(search, { target: { value: platform === 'macos' ? 'cmd+/' : 'control+/' } })
  expect(screen.getAllByRole('listitem')).toHaveLength(1)
  for (const query of ['sidebar', ' sDBr ', 'toggle left', platform === 'macos' ? '⌘B' : 'CtrlB', platform === 'macos' ? 'Cmd+B' : 'Control+B']) {
    fireEvent.change(search, { target: { value: query } })
    expect(screen.getAllByRole('listitem').map(row => row.textContent)).toEqual(['Toggle left sidebar' + (platform === 'macos' ? '⌘B' : 'Ctrl+B')])
  }
  fireEvent.change(search, { target: { value: 's' } })
  expect(screen.getAllByRole('button', { name: /^Edit shortcut for/ }).map(button => button.getAttribute('aria-label')))
    .toEqual(['Edit shortcut for Open shortcuts', 'Edit shortcut for Toggle left sidebar', 'Edit shortcut for Open settings'])
  fireEvent.change(search, { target: { value: platform === 'macos' ? '⌘ Enter' : 'Ctrl + Enter' } })
  expect(screen.getAllByRole('listitem')).toHaveLength(1)
  expect(screen.getByText(en.complementary)).toBeTruthy()
  for (const query of ['abc', 'sendEnter', 'not a command']) {
    fireEvent.change(search, { target: { value: query } })
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
    expect(screen.getByRole('status').textContent).toBe('No matching shortcuts')
  }
  act(() => { store.actions.open() })
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  fireEvent.keyDown(search, { key: 'Escape' })
  expect(store.getSnapshot().query).toBe('')
  expect(document.activeElement).toBe(opener)
  fireEvent.mouseEnter(opener)
  expect(screen.getByRole('tooltip').textContent).toBe(platform === 'macos' ? 'View shortcuts ⌘ /' : 'View shortcuts Ctrl + /')
  act(() => { catalog.set(catalog.getSnapshot().map(row => row.id === 'shortcuts.open'
    ? { ...row, binding: null, keys: [], aria: undefined } : row)) })
  expect(screen.queryByRole('tooltip')).toBeNull()
  fireEvent.mouseLeave(opener); fireEvent.mouseEnter(opener)
  expect(screen.queryByRole('tooltip')).toBeNull()
  act(() => { catalog.set([]) })
  expect(opener.hasAttribute('aria-keyshortcuts')).toBe(false)
  expect(makeTranslate(zh)('title')).toBe('快捷键')
})


it('saves individual edits and disables changes when configuration cannot be read', async () => {
  const store = createShortcutsStore().create()
  const catalog = createSnapshotStore<readonly ShortcutCatalogEntry[]>([
    { id: 'shortcuts.open' as ShortcutCommandId, label: 'Open shortcuts', aliases: [], binding: null, modified: true,
      conflicts: ['other.action' as ShortcutCommandId], issue: null, unavailableReason: null, keys: [], aria: undefined },
    { id: 'settings.open' as ShortcutCommandId, label: 'Open settings', aliases: [], binding: null, modified: true,
      conflicts: [], issue: 'reserved', unavailableReason: null, keys: [], aria: undefined },
  ])
  const config = createSnapshotStore<ShortcutConfigSnapshot>(initialShortcutConfig())
  const edit = vi.fn(async () => ({ status: 'saved' as const, snapshot: config.getSnapshot() }))
  const props = { actions: store.actions, useStore: bindSnapshotSelector(store), useCatalog: bindSnapshotSelector(catalog),
    useConfig: bindSnapshotSelector(config), useFixedCatalog: bindSnapshotSelector(createSnapshotStore([])), runtime: 'web', platform: 'macos', edit, recording: async () => {},
    describeBinding, t: makeTranslate(en) } as Parameters<typeof ShortcutReference>[0]
  store.actions.open()
  render(<ShortcutReference {...props} />)
  expect(screen.getByRole('button', { name: en['reset-all'] }).hasAttribute('disabled')).toBe(true)
  expect(screen.queryByText('Unavailable')).toBeNull()
  expect(screen.getByRole('button', { name: 'Edit shortcut for Open shortcuts' }).hasAttribute('disabled')).toBe(true)
  act(() => { config.set({ ...config.getSnapshot(), status: 'ready' }) })
  fireEvent.click(screen.getByRole('button', { name: 'Edit shortcut for Open shortcuts' }))
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  expect(screen.getByRole('group', { name: 'Open shortcuts' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: en.clear })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.reset }))
  await screen.findByText(en.saved)
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  act(() => { config.set({ ...config.getSnapshot(), status: 'unreadable', error: null }) })
  expect(screen.getByText(`${en.read} ${en['using-defaults']}`)).toBeTruthy()
  act(() => { config.set({ ...config.getSnapshot(), error: 'future', usingDefaults: false }) })
  expect(screen.getByText(`${en.future} ${en['using-accepted']}`)).toBeTruthy()
  expect(screen.getByRole('dialog').contains(screen.getByRole('alert'))).toBe(false)
  expect(screen.getByRole('button', { name: en['reset-all'] }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('button', { name: 'Edit shortcut for Open shortcuts' }).hasAttribute('disabled')).toBe(true)
})

function referenceFixture() {
  const store = createShortcutsStore().create()
  const catalog = createSnapshotStore<readonly ShortcutCatalogEntry[]>([
    { id: 'settings.open' as ShortcutCommandId, label: 'Open settings', aliases: [],
      binding: { code: 'Comma', modifiers: ['shift', 'meta'] }, modified: false,
      conflicts: [], issue: null, unavailableReason: null, keys: ['⇧', '⌘', ','], aria: 'Shift+Meta+,' },
  ])
  const config = createSnapshotStore<ShortcutConfigSnapshot>({ ...initialShortcutConfig(), status: 'ready' })
  const fixedCatalog = createSnapshotStore<readonly ShortcutFixedCatalogEntry[]>([])
  const edit = vi.fn<Parameters<typeof ShortcutReference>[0]['edit']>(async () => ({ status: 'saved', snapshot: config.getSnapshot() }))
  store.actions.open()
  const props = { actions: store.actions, useStore: bindSnapshotSelector(store), useCatalog: bindSnapshotSelector(catalog),
    useConfig: bindSnapshotSelector(config), useFixedCatalog: bindSnapshotSelector(fixedCatalog), runtime: 'web', platform: 'macos', edit,
    recording: async () => {}, describeBinding, t: makeTranslate(en) } as Parameters<typeof ShortcutReference>[0]
  const view = render(<ShortcutReference {...props} />)
  return { store, catalog, fixedCatalog, config, edit, view }
}

it('shows mounted fixed actions as searchable read-only rows and follows their label and lifetime', () => {
  const { fixedCatalog, store } = referenceFixture()
  const stop = { id: 'response.stop' as ShortcutCommandId, label: 'Stop reply', keys: ['Esc', 'Esc'], bindings: [{ code: 'Escape', modifiers: [] }], group: 'input' as const }
  const approve = { id: 'approval.accept' as ShortcutCommandId, label: 'Approve', keys: ['Enter'], bindings: [{ code: 'Enter', modifiers: [] }], group: 'approval' as const }
  act(() => { fixedCatalog.set([stop, approve]) })
  expect(screen.getByRole('region', { name: 'Approval area' }).textContent).toContain('Approve')
  expect(screen.getByRole('button', { name: 'Stop reply Esc Esc' }).hasAttribute('disabled')).toBe(true)
  expect(screen.queryByRole('button', { name: 'Edit shortcut for Stop reply' })).toBeNull()
  act(() => { store.actions.search('response.stop') })
  expect(screen.getAllByRole('listitem')).toHaveLength(1)
  act(() => { fixedCatalog.set([{ ...stop, label: '停止回复' }]) })
  expect(screen.queryByText('Stop reply')).toBeNull()
  expect(screen.getByText('停止回复')).toBeTruthy()
  act(() => { fixedCatalog.set([]) })
  expect(screen.queryAllByRole('listitem')).toHaveLength(0)
})

it('keeps action conditions out of labels and tooltips while retaining binding edits', () => {
  const f = referenceFixture()
  act(() => { f.catalog.set(f.catalog.getSnapshot().map(row => ({ ...row, unavailableReason: 'Select a session' }))) })
  const label = screen.getByText('Open settings', { selector: 'span' })
  expect(label.textContent).toBe('Open settings')
  expect(screen.queryByText('Select a session')).toBeNull()
  expect(screen.queryByText('Unavailable')).toBeNull()
  fireEvent.mouseEnter(label)
  expect(screen.queryByRole('tooltip')).toBeNull()
  fireEvent.mouseLeave(label)
  fireEvent.focus(label)
  expect(screen.queryByRole('tooltip')).toBeNull()
  expect(label.hasAttribute('tabindex')).toBe(false)
  expect(screen.getByRole('button', { name: 'Edit shortcut for Open settings' }).hasAttribute('disabled')).toBe(false)
  act(() => { f.catalog.set(f.catalog.getSnapshot().map(row => ({ ...row, unavailableReason: null }))) })
  expect(label.textContent).toBe('Open settings')
})

it.each(['conflict', 'reserved'] as const)('omits status labels for a %s binding', (failure) => {
  const f = referenceFixture()
  act(() => { f.catalog.set(f.catalog.getSnapshot().map(row => ({ ...row,
    unavailableReason: 'Focus a right sidebar pane first',
    conflicts: failure === 'conflict' ? ['pane.split' as ShortcutCommandId] : [],
    issue: failure === 'reserved' ? 'reserved' : null,
  }))) })
  expect(screen.queryByText('Unavailable')).toBeNull()
  expect(screen.queryByText('Focus a right sidebar pane first')).toBeNull()
  expect(screen.getByRole('button', { name: 'Edit shortcut for Open settings' }).hasAttribute('disabled')).toBe(false)
})

it('removes from the row and replaces failure feedback with a fresh system success toast', async () => {
  vi.useFakeTimers()
  try {
    const f = referenceFixture()
    f.edit.mockResolvedValueOnce({ status: 'write-failed', snapshot: f.config.getSnapshot() })
    const remove = screen.getByRole('button', { name: 'Remove shortcut for Open settings' })
    await act(async () => { remove.click() })
    expect(screen.getByRole('alert').textContent).toBe(en['write-failed'])
    expect(screen.getByRole('dialog').contains(screen.getByRole('alert'))).toBe(false)
    act(() => { vi.advanceTimersByTime(2000) })
    await act(async () => { remove.click() })
    expect(f.edit).toHaveBeenLastCalledWith({ type: 'set', id: 'settings.open', binding: null }, f.config.getSnapshot().revision)
    expect(screen.getByRole('alert').textContent).toBe(en.saved)
    act(() => { vi.advanceTimersByTime(2000) })
    expect(screen.getByRole('alert').textContent).toBe(en.saved)
    act(() => { vi.advanceTimersByTime(2000) })
    expect(screen.queryByRole('alert')).toBeNull()
  } finally { vi.useRealTimers() }
})

it('opens the same recorder from a key badge and retains the editor when restoring defaults fails', async () => {
  const f = referenceFixture()
  f.edit.mockResolvedValueOnce({ status: 'write-failed', snapshot: f.config.getSnapshot() })
  fireEvent.click(screen.getByRole('button', { name: 'Open settings ⇧ ⌘ ,' }))
  await act(async () => { screen.getByRole('button', { name: en.reset }).click() })
  expect(f.edit).toHaveBeenLastCalledWith({ type: 'reset', id: 'settings.open' }, f.config.getSnapshot().revision)
  expect(screen.getByRole('alert').textContent).toBe(en['write-failed'])
  expect(screen.getByRole('group', { name: 'Open settings' })).toBeTruthy()
})

it('coalesces repeated recording errors without extending the toast and immediately shows changed feedback', async () => {
  vi.useFakeTimers()
  try {
    const f = referenceFixture()
    fireEvent.click(screen.getByRole('button', { name: 'Edit shortcut for Open settings' }))
    const recorder = screen.getByRole('button', { name: en.record }); recorder.focus()
    const press = (key: string, code: string, modifiers: KeyboardEventInit = {}): void => {
      fireEvent.keyDown(recorder, { key, code, ...modifiers })
      fireEvent.keyUp(recorder, { key, code, ...modifiers })
    }
    press('z', 'KeyZ')
    const firstError = screen.getByRole('alert')
    expect(firstError.textContent).toBe(en['modifier-required'])
    for (const key of 'hongwen') {
      act(() => { vi.advanceTimersByTime(500) })
      press(key, `Key${key.toUpperCase()}`)
      expect(screen.getByRole('alert')).toBe(firstError)
      expect(recorder.getAttribute('aria-invalid')).toBe('true')
    }
    act(() => { vi.advanceTimersByTime(500) })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(f.edit).not.toHaveBeenCalled()
    press('i', 'KeyI')
    const nextError = screen.getByRole('alert')
    expect(nextError.textContent).toBe(en['modifier-required'])
    expect(nextError).not.toBe(firstError)
    press('r', 'KeyR', { metaKey: true })
    expect(screen.getByRole('alert').textContent).toBe(en['unsupported-browser'])
    await act(async () => { press('.', 'Period', { metaKey: true, shiftKey: true }) })
    expect(screen.getByRole('alert').textContent).toBe(en.saved)
    expect(f.edit).toHaveBeenCalledOnce()
    expect(screen.queryByRole('group')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('dialog'))
  } finally { cleanup(); vi.useRealTimers() }
})

it('keeps failed edits open and returns cancelled and saved edits to the dialog', async () => {
  referenceFixture()
  fireEvent.click(screen.getByRole('button', { name: 'Edit shortcut for Open settings' }))
  const recorder = screen.getByRole('button', { name: en.record }); recorder.focus()
  fireEvent.keyDown(recorder, { key: 'r', code: 'KeyR', metaKey: true })
  fireEvent.keyUp(recorder, { code: 'KeyR' })
  expect(screen.getByRole('alert').textContent).toBe(en['unsupported-browser'])
  expect(recorder.getAttribute('aria-invalid')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: en.close }))
  expect(screen.queryByRole('group')).toBeNull()
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(document.activeElement).toBe(screen.getByRole('dialog'))
  fireEvent.click(screen.getByRole('button', { name: 'Edit shortcut for Open settings' }))
  const retryRecorder = screen.getByRole('button', { name: en.record }); retryRecorder.focus()
  fireEvent.keyDown(retryRecorder, { key: 'i', code: 'KeyI' })
  fireEvent.keyUp(retryRecorder, { code: 'KeyI' })
  expect(screen.getByRole('alert').textContent).toBe(en['modifier-required'])
  fireEvent.keyDown(retryRecorder, { key: '.', code: 'Period', metaKey: true, shiftKey: true })
  fireEvent.keyUp(retryRecorder, { code: 'Period' })
  await screen.findByText(en.saved)
  expect(screen.queryByRole('group')).toBeNull()
  expect(document.activeElement).toBe(screen.getByRole('dialog'))
})

it('blocks reference dismissal during a removal and ignores its completion after unmount', async () => {
  const f = referenceFixture()
  let settle!: (value: Awaited<ReturnType<typeof f.edit>>) => void
  const reply = new Promise<Awaited<ReturnType<typeof f.edit>>>((resolve) => { settle = resolve })
  f.edit.mockReturnValueOnce(reply)
  fireEvent.click(screen.getByRole('button', { name: 'Remove shortcut for Open settings' }))
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  expect(f.store.getSnapshot().open).toBe(true)
  f.view.unmount()
  await act(async () => { settle({ status: 'saved', snapshot: f.config.getSnapshot() }); await reply })
  expect(screen.queryByRole('alert')).toBeNull()
})

it('counts current-profile overrides even when hidden by search or an unloaded command, and cancels without saving', () => {
  const f = referenceFixture()
  const restore = screen.getByRole('button', { name: en['reset-all'] })
  expect(restore.hasAttribute('disabled')).toBe(true)
  act(() => { f.config.set({ ...f.config.getSnapshot(), document: { schemaVersion: 2, profiles: {
    'desktop:macos': { 'settings.open': null },
  } } }) })
  expect(restore.hasAttribute('disabled')).toBe(true)
  act(() => {
    f.config.set({ ...f.config.getSnapshot(), document: { schemaVersion: 2, profiles: {
      'web:macos': { 'settings.open': null, 'unloaded.command': { code: 'KeyI', modifiers: ['meta', 'alt'] } },
      'web:windows': { 'settings.open': null },
    } } })
    f.store.actions.search('no matching command')
  })
  expect(screen.getByText('2 customized')).toBeTruthy()
  expect(screen.queryAllByRole('listitem')).toHaveLength(0)
  restore.focus(); fireEvent.click(restore)
  const confirmation = screen.getByRole('dialog', { name: en['reset-title'] })
  expect(confirmation.textContent).toContain(en['reset-description'])
  const cancel = within(confirmation).getByRole('button', { name: en.cancel })
  expect(document.activeElement).toBe(cancel)
  act(() => { f.store.actions.open() })
  expect(document.activeElement).toBe(cancel)
  fireEvent.click(cancel)
  expect(screen.queryByRole('dialog', { name: en['reset-title'] })).toBeNull()
  expect(document.activeElement).toBe(restore)
  expect(f.edit).not.toHaveBeenCalled()
  fireEvent.click(restore)
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  expect(f.store.getSnapshot().open).toBe(true)
})

it('restores focus to Reset All when clicking it does not move focus out of the recorder', () => {
  const f = referenceFixture()
  act(() => { f.config.set({ ...f.config.getSnapshot(), document: { schemaVersion: 1, profiles: {
    'web:macos': { 'settings.open': null },
  } } }) })
  fireEvent.click(screen.getByRole('button', { name: 'Edit shortcut for Open settings' }))
  const recorder = screen.getByRole('button', { name: en.record })
  recorder.focus()
  const restore = screen.getByRole('button', { name: en['reset-all'] })
  // Safari mouse clicks do not focus buttons; fireEvent keeps the recorder focused until the handler runs.
  fireEvent.click(restore)
  expect(recorder.isConnected).toBe(false)
  const confirmation = screen.getByRole('dialog', { name: en['reset-title'] })
  const cancel = within(confirmation).getByRole('button', { name: en.cancel })
  expect(document.activeElement).toBe(cancel)
  fireEvent.click(cancel)
  expect(document.activeElement).toBe(restore)
  expect(f.edit).not.toHaveBeenCalled()
})

it('restores defaults after confirmation and retains accepted configuration when the write fails', async () => {
  const f = referenceFixture()
  act(() => { f.config.set({ ...f.config.getSnapshot(), document: { schemaVersion: 1, profiles: {
    'web:macos': { 'settings.open': null },
  } } }) })
  const original = f.config.getSnapshot()
  let settle!: (result: Awaited<ReturnType<typeof f.edit>>) => void
  f.edit.mockReturnValueOnce(new Promise((resolve) => { settle = resolve }))
  const restore = screen.getByRole('button', { name: en['reset-all'] })
  restore.focus(); fireEvent.click(restore)
  const confirmation = screen.getByRole('dialog', { name: en['reset-title'] })
  const confirm = within(confirmation).getByRole('button', { name: en.reset })
  fireEvent.click(confirm)
  expect(f.edit).toHaveBeenCalledWith({ type: 'reset-all' }, original.revision)
  expect(confirm.hasAttribute('disabled')).toBe(true)
  expect(within(confirmation).getByRole('button', { name: en.cancel }).hasAttribute('disabled')).toBe(true)
  fireEvent.keyDown(confirmation, { key: 'Escape' })
  expect(screen.getByRole('dialog', { name: en['reset-title'] })).toBeTruthy()
  await act(async () => { settle({ status: 'write-failed', snapshot: original }) })
  expect(screen.getByRole('alert').textContent).toBe(en['reset-failed'])
  expect(f.config.getSnapshot()).toBe(original)
  expect(screen.getByText('1 customized')).toBeTruthy()
  f.edit.mockImplementationOnce(async () => {
    const snapshot = { ...original, document: { schemaVersion: 1 as const, profiles: {} } }
    f.config.set(snapshot)
    return { status: 'saved', snapshot }
  })
  await act(async () => { confirm.click() })
  expect(screen.queryByRole('dialog', { name: en['reset-title'] })).toBeNull()
  expect(screen.getByRole('alert').textContent).toBe(en['reset-saved'])
  expect(screen.getByText('0 customized')).toBeTruthy()
  expect(restore.hasAttribute('disabled')).toBe(true)
  expect(document.activeElement).toBe(screen.getByRole('searchbox'))
})

it('requires a new confirmation when another window changes the configuration', async () => {
  const f = referenceFixture()
  act(() => { f.config.set({ ...f.config.getSnapshot(), document: { schemaVersion: 1, profiles: {
    'web:macos': { 'settings.open': null },
  } } }) })
  const original = f.config.getSnapshot()
  fireEvent.click(screen.getByRole('button', { name: en['reset-all'] }))
  const updated = { ...original, revision: initialShortcutConfig().revision }
  act(() => { f.config.set(updated) })
  f.edit.mockResolvedValueOnce({ status: 'stale', snapshot: updated })
  await act(async () => {
    within(screen.getByRole('dialog', { name: en['reset-title'] })).getByRole('button', { name: en.reset }).click()
  })
  expect(f.edit).toHaveBeenCalledWith({ type: 'reset-all' }, original.revision)
  expect(f.edit).toHaveBeenCalledOnce()
  expect(screen.queryByRole('dialog', { name: en['reset-title'] })).toBeNull()
  expect(screen.getByRole('alert').textContent).toBe(en.stale)
  fireEvent.click(screen.getByRole('button', { name: en['reset-all'] }))
  await act(async () => {
    within(screen.getByRole('dialog', { name: en['reset-title'] })).getByRole('button', { name: en.reset }).click()
  })
  expect(f.edit).toHaveBeenLastCalledWith({ type: 'reset-all' }, updated.revision)
})

it('keeps an active recorder focused when another window resets the profile', () => {
  const f = referenceFixture()
  act(() => { f.config.set({ ...f.config.getSnapshot(), document: { schemaVersion: 1, profiles: {
    'web:macos': { 'settings.open': null },
  } } }) })
  fireEvent.click(screen.getByRole('button', { name: 'Edit shortcut for Open settings' }))
  const recorder = screen.getByRole('button', { name: en.record })
  recorder.focus()
  act(() => { f.config.set({ ...initialShortcutConfig(), status: 'ready' }) })
  expect(document.activeElement).toBe(recorder)
  expect(screen.getByRole('group', { name: 'Open settings' })).toBeTruthy()
})
