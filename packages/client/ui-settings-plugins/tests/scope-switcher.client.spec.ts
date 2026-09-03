/**
 * The scope switch's options: roster presets, document-only scopes, and the
 * roster request lifecycle.
 */

import { describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsDescribeFace, SettingsMirrorSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { ScopeSelection } from '../src/client/scoped-form.ts'
import { ScopeSwitcherController, type PresetScopeRow } from '../src/client/scope-switcher.ts'

const STANDARD: PresetScopeRow = { id: 'standard', trust: 'system', isDefault: true }

function describeFace(scopes: readonly string[] = []) {
  const store = createSnapshotStore<SettingsMirrorSnapshot>({
    status: 'ready',
    view: { writable: true, hasDocument: true, namespaces: [], scopes },
    error: null,
  })
  const face: SettingsDescribeFace = {
    getSnapshot: () => store.getSnapshot(),
    subscribe: listener => store.subscribe(listener),
    ensure: () => Promise.resolve(),
    acceptView: () => {},
  }
  return { face, store }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('ScopeSwitcherController', () => {
  it('reads the roster once from idle, lists document-only scopes, and follows the selection', async () => {
    const selection = new ScopeSelection()
    const { face, store } = describeFace(['preset/standard', 'preset/deleted'])
    const roster = vi.fn(() => Promise.resolve([STANDARD]))
    const controller = new ScopeSwitcherController(selection, face, roster, preset => preset.name ?? preset.id)
    const injected = controller.inject()
    expect(injected.hooks.scopeSwitcher.getSnapshot()).toEqual({
      scope: undefined, presets: [], extraScopes: ['preset/standard', 'preset/deleted'], status: 'idle',
    })
    injected.ensureScopes()
    injected.ensureScopes()
    expect(injected.hooks.scopeSwitcher.getSnapshot().status).toBe('loading')
    await vi.waitFor(() => { expect(injected.hooks.scopeSwitcher.getSnapshot().status).toBe('ready') })
    expect(roster).toHaveBeenCalledTimes(1)
    expect(injected.hooks.scopeSwitcher.getSnapshot()).toMatchObject({
      presets: [STANDARD], extraScopes: ['preset/deleted'],
    })
    injected.ensureScopes()
    expect(roster).toHaveBeenCalledTimes(1)
    expect(injected.presetName(STANDARD)).toBe('standard')

    const before = injected.hooks.scopeSwitcher.getSnapshot()
    // An unrelated mirror refresh keeps the reference.
    store.set({ ...store.getSnapshot() })
    expect(injected.hooks.scopeSwitcher.getSnapshot()).toBe(before)
    injected.selectScope('preset/standard')
    expect(injected.hooks.scopeSwitcher.getSnapshot().scope).toBe('preset/standard')
    injected.selectScope(null)
    expect(selection.current()).toBeUndefined()
    // A document gaining a scope section shows it.
    store.set({ ...store.getSnapshot(), view: { writable: true, hasDocument: true, namespaces: [], scopes: ['preset/x'] } })
    expect(injected.hooks.scopeSwitcher.getSnapshot().extraScopes).toEqual(['preset/x'])
    controller.dispose()
    const after = injected.hooks.scopeSwitcher.getSnapshot()
    injected.selectScope('preset/x')
    expect(injected.hooks.scopeSwitcher.getSnapshot()).toBe(after)
  })

  it('reports a failed roster, retries it, and answers ready at once without a roster', async () => {
    const selection = new ScopeSelection()
    const { face } = describeFace()
    const roster = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([STANDARD])
    const controller = new ScopeSwitcherController(selection, face, roster, preset => preset.id)
    await controller.load()
    expect(controller.inject().hooks.scopeSwitcher.getSnapshot().status).toBe('error')
    await controller.load()
    expect(controller.inject().hooks.scopeSwitcher.getSnapshot()).toMatchObject({ status: 'ready', presets: [STANDARD] })

    const bare = new ScopeSwitcherController(selection, face, undefined, preset => preset.id)
    await bare.load()
    expect(bare.inject().hooks.scopeSwitcher.getSnapshot()).toMatchObject({ status: 'ready', presets: [] })
  })

  it('drops a late answer after a reset or disposal', async () => {
    const selection = new ScopeSelection()
    const { face } = describeFace()
    const first = deferred<readonly PresetScopeRow[]>()
    const roster = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce([STANDARD])
    const controller = new ScopeSwitcherController(selection, face, roster, preset => preset.id)
    const loading = controller.load()
    controller.reset()
    expect(controller.inject().hooks.scopeSwitcher.getSnapshot().status).toBe('idle')
    first.resolve([{ id: 'stale', trust: 'user', isDefault: false }])
    await loading
    expect(controller.inject().hooks.scopeSwitcher.getSnapshot()).toMatchObject({ status: 'idle', presets: [] })
    await controller.load()
    expect(controller.inject().hooks.scopeSwitcher.getSnapshot().presets).toEqual([STANDARD])

    const second = deferred<readonly PresetScopeRow[]>()
    const late = new ScopeSwitcherController(selection, face, () => second.promise, preset => preset.id)
    const pending = late.load()
    late.dispose()
    late.reset()
    second.resolve([STANDARD])
    await pending
    expect(late.inject().hooks.scopeSwitcher.getSnapshot()).toMatchObject({ status: 'loading', presets: [] })
  })
})
