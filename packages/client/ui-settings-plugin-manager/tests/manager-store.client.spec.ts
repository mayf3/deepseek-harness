/**
 * The manager store: what it reads, how actions cross the wire, which
 * failures become notices, and how the install run folds its output.
 */

import { describe, expect, it, vi } from 'vitest'
import type { PluginPackageView } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { PluginManagerController, rowKey, type PresetGroup } from '../src/client/manager-store.ts'

const BUNDLE: PluginPackageView = {
  name: 'dsh-better-sidebar',
  version: '0.16.0',
  kind: 'bundle',
  trust: 'external',
  stage: 'runtime',
  installed: true,
  enabled: false,
  status: 'disabled',
  cordisSameCopy: true,
  rows: [],
  overrides: [],
  addable: [],
  liveReload: true,
}

const STANDARD: PresetGroup = {
  id: 'standard',
  trust: 'system',
  isDefault: true,
  rows: [{ entryId: 'bash', moduleName: '@deepseek-ai/dsh-tool-bash', enabled: true, fiberPhase: null, source: 'preset' }],
}

/** One host-tree row the inventory lists, as far as the store reads it. */
const GLOBAL_ENTRY = {
  entryId: 'include:ui-settings', moduleName: '@deepseek-ai/dsh-client-ui-settings', enabled: true, fiberPhase: 'active', trust: 'builtin',
} as const

/** What one install run answers. */
type InstallValue = {
  installed: string[]
  removed: { name: string; reason: string }[]
  enabled: string[]
  installedOnly: string[]
  plain: string[]
  jobId: string
}

function ok<T>(value: T) {
  return { ok: true as const, value }
}

function refused(code: string, message: string, details: object = {}) {
  // The double's code map is keyed by literal codes; a spec-chosen string stands in.
  return { ok: false as const, error: new RemoteError(code as never, message, details as never) }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

function bench(overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}) {
  const plugins = {
    list: vi.fn(() => Promise.resolve(ok([BUNDLE]))),
    add: vi.fn(() => Promise.resolve(ok({ installed: ['a'], removed: [], enabled: [], installedOnly: [], plain: [], jobId: 'j1' }))),
    uninstall: vi.fn(() => Promise.resolve(ok(undefined))),
    enable: vi.fn(() => Promise.resolve(ok({ changed: true, effect: 'live' }))),
    disable: vi.fn(() => Promise.resolve(ok({ changed: true, effect: 'restart' }))),
    retry: vi.fn(() => Promise.resolve(ok({ changed: true, effect: 'live' }))),
    addRow: vi.fn(() => Promise.resolve(ok({ target: { kind: 'global' }, rowId: 'r', file: '/f' }))),
    removeRow: vi.fn(() => Promise.resolve(ok(undefined))),
    setRowDisabled: vi.fn(() => Promise.resolve(ok(undefined))),
    dependents: vi.fn(() => Promise.resolve(ok({ services: [], references: [] }))),
    ...overrides,
  }
  const inventory = { list: vi.fn(() => Promise.resolve(ok({ entries: [GLOBAL_ENTRY], agentPresets: [STANDARD] }))) }
  const ctx = { remote: { plugins, pluginInventory: inventory } } as never
  const controller = new PluginManagerController(ctx, preset => preset.name ?? preset.id)
  const face = controller.inject()
  return { plugins, inventory, controller, face, state: () => controller.getSnapshot() }
}

describe('PluginManagerController', () => {
  it('starts idle, reads packages and presets on first use, and folds concurrent loads', async () => {
    const gate = deferred<ReturnType<typeof ok<PluginPackageView[]>>>()
    const { plugins, face, state, controller } = bench({ list: vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue(ok([BUNDLE])) })
    expect(state().status).toBe('idle')
    face.ensure()
    face.ensure()
    await Promise.resolve()
    expect(state().status).toBe('loading')
    const mid = controller.load()
    gate.resolve(ok([]))
    await mid
    // The in-flight read reran once for the load that landed mid-read.
    expect(plugins.list).toHaveBeenCalledTimes(2)
    expect(state()).toMatchObject({ status: 'ready', packages: [BUNDLE], presets: [STANDARD], globalModules: [GLOBAL_ENTRY.moduleName] })
    face.ensure()
    expect(plugins.list).toHaveBeenCalledTimes(2)
    face.refresh()
    await controller.load()
    expect(plugins.list).toHaveBeenCalledTimes(3)
    expect(face.presetName(STANDARD)).toBe('standard')
  })

  it('reports an unavailable profile runtime and keeps the last packages across a failed read', async () => {
    const { plugins, controller, state } = bench({
      list: vi.fn()
        .mockResolvedValueOnce(refused('plugins/unavailable', 'no profile', { reason: 'no profile' }))
        .mockResolvedValueOnce(ok([BUNDLE]))
        .mockResolvedValueOnce(refused('gateway/internal', 'boom')),
    })
    await controller.load()
    expect(state().status).toBe('unavailable')
    await controller.load()
    expect(state()).toMatchObject({ status: 'ready', packages: [BUNDLE] })
    await controller.load()
    expect(state()).toMatchObject({ status: 'error', packages: [BUNDLE] })
    expect(plugins.list).toHaveBeenCalledTimes(3)
  })

  it('keeps the held presets and host-tree modules when the inventory read is refused', async () => {
    const { inventory, controller, state } = bench()
    await controller.load()
    inventory.list.mockResolvedValueOnce(refused('gateway/internal', 'boom') as never)
    await controller.load()
    expect(state().presets).toEqual([STANDARD])
    expect(state().globalModules).toEqual([GLOBAL_ENTRY.moduleName])
  })

  it('enables a bundle, marks it busy meanwhile, and says when a restart is needed', async () => {
    const gate = deferred<ReturnType<typeof ok<{ changed: boolean; effect: 'live' | 'restart' }>>>()
    const { plugins, face, state, controller } = bench({ enable: vi.fn().mockReturnValueOnce(gate.promise) })
    await controller.load()
    face.setEnabled(BUNDLE.name, true)
    face.setEnabled(BUNDLE.name, true)
    expect(state().busy).toEqual([BUNDLE.name])
    expect(plugins.enable).toHaveBeenCalledTimes(1)
    gate.resolve(ok({ changed: true, effect: 'restart' }))
    await vi.waitFor(() => { expect(state().busy).toEqual([]) })
    expect(state().notice).toEqual({ kind: 'restart', packageName: BUNDLE.name })
    expect(plugins.list).toHaveBeenCalledTimes(2)
    face.dismissNotice()
    expect(state().notice).toBeNull()
  })

  it('turns a refused enable into a notice carrying the Host reason, or its message without one', async () => {
    const { face, state, controller } = bench({
      enable: vi.fn()
        .mockResolvedValueOnce(refused('plugins/not-enableable', 'plugin-manager: x cannot', { reason: 'foreign cordis' }))
        .mockResolvedValueOnce(refused('plugins/not-enableable', 'no string reason', { reason: 42 })),
    })
    await controller.load()
    face.setEnabled(BUNDLE.name, true)
    await vi.waitFor(() => { expect(state().notice).not.toBeNull() })
    expect(state().notice).toEqual({
      kind: 'failed', code: 'plugins/not-enableable', reason: 'foreign cordis', packageName: BUNDLE.name,
    })
    expect(state().busy).toEqual([])
    face.setEnabled(BUNDLE.name, true)
    await vi.waitFor(() => { expect(state().notice).toMatchObject({ reason: 'no string reason' }) })
  })

  it('disables at once when nothing depends on the bundle, and asks first when something does', async () => {
    const { plugins, face, state, controller } = bench()
    await controller.load()
    face.setEnabled(BUNDLE.name, false)
    await vi.waitFor(() => { expect(plugins.disable).toHaveBeenCalledWith(BUNDLE.name) })
    await vi.waitFor(() => { expect(state().notice).toEqual({ kind: 'restart', packageName: BUNDLE.name }) })

    plugins.dependents.mockResolvedValueOnce(ok({
      services: [{ service: 'sidebar', providedBy: 'dsh-better-sidebar/better-sidebar', injectedBy: ['x'] }],
      references: [],
    }) as never)
    face.setEnabled(BUNDLE.name, false)
    expect(state().confirm).toEqual({ action: 'disable', packageName: BUNDLE.name, dependents: undefined })
    await vi.waitFor(() => { expect(state().confirm?.dependents).toBeDefined() })
    face.confirm()
    expect(state().confirm).toBeNull()
    await vi.waitFor(() => { expect(plugins.disable).toHaveBeenCalledTimes(2) })
  })

  it('always asks before uninstalling, and cancelling runs nothing', async () => {
    const { plugins, face, state, controller } = bench()
    await controller.load()
    face.uninstall(BUNDLE.name)
    await vi.waitFor(() => { expect(state().confirm?.dependents).toEqual({ services: [], references: [] }) })
    face.cancelConfirm()
    expect(state().confirm).toBeNull()
    face.confirm()
    await Promise.resolve()
    expect(plugins.uninstall).not.toHaveBeenCalled()

    face.uninstall(BUNDLE.name)
    await vi.waitFor(() => { expect(state().confirm?.dependents).toBeDefined() })
    face.confirm()
    await vi.waitFor(() => { expect(plugins.uninstall).toHaveBeenCalledWith(BUNDLE.name) })
    await vi.waitFor(() => { expect(state().notice).toEqual({ kind: 'done', packageName: BUNDLE.name }) })
    expect(state().confirm).toBeNull()
  })

  it('drops a dependents answer that arrives after the confirmation changed', async () => {
    const gate = deferred<ReturnType<typeof ok<{ services: never[]; references: never[] }>>>()
    const { plugins, face, state, controller } = bench({ dependents: vi.fn().mockReturnValueOnce(gate.promise) })
    await controller.load()
    face.uninstall(BUNDLE.name)
    face.cancelConfirm()
    gate.resolve(ok({ services: [], references: [] }))
    await Promise.resolve()
    await Promise.resolve()
    expect(state().confirm).toBeNull()
    // A refused dependents read confirms with an empty list rather than blocking.
    plugins.dependents.mockResolvedValueOnce(refused('gateway/internal', 'boom') as never)
    face.uninstall(BUNDLE.name)
    await vi.waitFor(() => { expect(state().confirm?.dependents).toEqual({ services: [], references: [] }) })
  })

  it('retries, adds rows, removes rows, and switches rows under their own busy keys', async () => {
    const { plugins, face, state, controller } = bench()
    await controller.load()
    face.retry(BUNDLE.name)
    await vi.waitFor(() => { expect(plugins.retry).toHaveBeenCalledWith(BUNDLE.name) })
    await vi.waitFor(() => { expect(state().notice).toEqual({ kind: 'done', packageName: BUNDLE.name }) })

    face.addRow('@fixture/tool', '.', { kind: 'preset', preset: 'standard' })
    await vi.waitFor(() => {
      expect(plugins.addRow).toHaveBeenCalledWith('@fixture/tool', { kind: 'preset', preset: 'standard' }, { module: '.' })
    })
    await vi.waitFor(() => { expect(state().notice).toEqual({ kind: 'done', packageName: '@fixture/tool' }) })

    const target = { kind: 'preset', preset: 'standard' } as const
    face.setRowDisabled(target, 'bash', true)
    expect(state().busy).toEqual([rowKey(target, 'bash')])
    await vi.waitFor(() => { expect(plugins.setRowDisabled).toHaveBeenCalledWith(target, 'bash', true) })
    await vi.waitFor(() => { expect(state().busy).toEqual([]) })
    face.removeRow(target, 'extra')
    await vi.waitFor(() => { expect(plugins.removeRow).toHaveBeenCalledWith(target, 'extra') })
    await vi.waitFor(() => { expect(state().busy).toEqual([]) })
  })

  it('reports a row conflict with the row id and a thrown transport failure generically', async () => {
    const { face, state, controller } = bench({
      addRow: vi.fn(() => Promise.resolve(refused('plugins/row-conflict', 'taken', { rowId: 'r', target: { kind: 'global' } }))),
      removeRow: vi.fn(() => Promise.reject(new Error('offline'))),
      // A rejection that is not an Error reaches the notice by its string form.
      setRowDisabled: vi.fn().mockRejectedValueOnce('plain text'),
    })
    await controller.load()
    face.addRow('p', 'p', { kind: 'global' })
    await vi.waitFor(() => { expect(state().notice).toMatchObject({ kind: 'failed' }) })
    expect(state().notice).toEqual({ kind: 'failed', code: 'plugins/row-conflict', reason: 'taken', packageName: 'p' })
    face.removeRow({ kind: 'global' }, 'r')
    await vi.waitFor(() => {
      expect(state().notice).toEqual({ kind: 'failed', code: 'gateway/internal', reason: 'offline', rowId: 'r' })
    })
    face.setRowDisabled({ kind: 'global' }, 'r', true)
    await vi.waitFor(() => { expect(state().notice).toMatchObject({ reason: 'plain text' }) })
  })

  it('runs an install, folds its own log chunks, and closes only once it settled', async () => {
    const gate = deferred<ReturnType<typeof ok<InstallValue>>>()
    const { plugins, face, state, controller } = bench({ add: vi.fn().mockReturnValueOnce(gate.promise) })
    await controller.load()
    face.runInstall()
    expect(plugins.add).not.toHaveBeenCalled()
    face.openInstall()
    expect(state().install).toMatchObject({ open: true, spec: '', enable: true, phase: 'idle' })
    face.editInstallSpec('  dsh-better-sidebar ')
    face.toggleInstallEnable()
    face.runInstall()
    face.runInstall()
    expect(plugins.add).toHaveBeenCalledTimes(1)
    expect(plugins.add).toHaveBeenCalledWith('dsh-better-sidebar', { enable: false })
    expect(state().install.phase).toBe('running')
    face.closeInstall()
    expect(state().install.open).toBe(true)
    controller.appendLog({ jobId: 'j1', spec: 'dsh-better-sidebar', stream: 'stdout', text: 'Progress\n' })
    controller.appendLog({ jobId: 'j2', spec: 'other', stream: 'stdout', text: 'not mine' })
    expect(state().install.log).toBe('Progress\n')
    gate.resolve(ok({
      installed: ['dsh-better-sidebar', 'dsh-tool-foo'], removed: [{ name: 'lib', reason: 'not a plugin' }],
      enabled: [], installedOnly: ['dsh-better-sidebar'], plain: ['dsh-tool-foo'], jobId: 'j1',
    }))
    await vi.waitFor(() => { expect(state().install.phase).toBe('done') })
    expect(state().install).toMatchObject({
      installed: ['dsh-better-sidebar', 'dsh-tool-foo'],
      enabled: [],
      installedOnly: ['dsh-better-sidebar'],
      plain: ['dsh-tool-foo'],
      removed: [{ name: 'lib', reason: 'not a plugin' }],
    })
    controller.appendLog({ jobId: 'j1', spec: 'dsh-better-sidebar', stream: 'stdout', text: 'late', exitCode: 0 })
    expect(state().install.log).toBe('Progress\n')
    await vi.waitFor(() => { expect(plugins.list).toHaveBeenCalledTimes(2) })
    face.closeInstall()
    expect(state().install.open).toBe(false)
  })

  it('settles an install and a confirmation while reads run beside them', async () => {
    const addGate = deferred<ReturnType<typeof ok<InstallValue>>>()
    const dependentsGate = deferred<ReturnType<typeof ok<{ services: never[]; references: never[] }>>>()
    const { plugins, face, state, controller } = bench({
      add: vi.fn().mockReturnValueOnce(addGate.promise),
      dependents: vi.fn().mockReturnValueOnce(dependentsGate.promise),
    })
    await controller.load()
    face.openInstall()
    face.editInstallSpec('pkg')
    face.runInstall()
    // The Host announces the change before the run answers; the read it triggers must not drop the answer.
    await controller.load()
    addGate.resolve(ok({ installed: ['pkg'], removed: [], enabled: ['pkg'], installedOnly: [], plain: [], jobId: 'j' }))
    await vi.waitFor(() => { expect(state().install.phase).toBe('done') })

    face.uninstall(BUNDLE.name)
    await controller.load()
    dependentsGate.resolve(ok({ services: [], references: [] }))
    await vi.waitFor(() => { expect(state().confirm?.dependents).toEqual({ services: [], references: [] }) })
    expect(plugins.list).toHaveBeenCalledTimes(4)
  })

  it('shows the Host log of a failed install, or its message when no chunk arrived', async () => {
    const { face, state, controller, plugins } = bench({
      add: vi.fn()
        .mockResolvedValueOnce(refused('plugins/install-failed', 'exit 1', { spec: 'x', exitCode: 1, log: 'ERR_PNPM' }))
        .mockResolvedValueOnce(refused('gateway/internal', 'offline'))
        .mockResolvedValueOnce(refused('plugins/install-failed', 'exit 1', { spec: 'x', exitCode: 1, log: 'tail' }))
        .mockResolvedValueOnce(refused('plugins/enable-failed', 'plugin-manager: x rejected', { packageName: 'x', reason: 'the tree rejected it' })),
    })
    await controller.load()
    face.openInstall()
    face.editInstallSpec('x')
    face.runInstall()
    await vi.waitFor(() => { expect(state().install.phase).toBe('failed') })
    expect(state().install.log).toBe('ERR_PNPM')
    expect(state().install.failure).toEqual({ code: 'plugins/install-failed', reason: 'ERR_PNPM' })
    face.runInstall()
    await vi.waitFor(() => { expect(plugins.add).toHaveBeenCalledTimes(2) })
    await vi.waitFor(() => { expect(state().install.log).toBe('offline') })
    face.runInstall()
    controller.appendLog({ jobId: 'j', spec: 'x', stream: 'stderr', text: 'streamed' })
    await vi.waitFor(() => { expect(plugins.add).toHaveBeenCalledTimes(3) })
    await vi.waitFor(() => { expect(state().install.phase).toBe('failed') })
    // The Host's captured log follows what streamed; a refusal after a clean
    // pnpm run follows it with its reason.
    expect(state().install.log).toBe('streamed\ntail')
    face.runInstall()
    controller.appendLog({ jobId: 'j', spec: 'x', stream: 'stdout', text: 'Done' })
    await vi.waitFor(() => { expect(plugins.add).toHaveBeenCalledTimes(4) })
    await vi.waitFor(() => { expect(state().install.phase).toBe('failed') })
    expect(state().install.log).toBe('Done\nthe tree rejected it')
  })

  it('drops every late settlement after disposal', async () => {
    const enableGate = deferred<ReturnType<typeof ok<{ changed: boolean; effect: 'live' }>>>()
    const installGate = deferred<ReturnType<typeof ok<InstallValue>>>()
    const { face, state, controller } = bench({
      enable: vi.fn().mockReturnValueOnce(enableGate.promise),
      add: vi.fn().mockReturnValueOnce(installGate.promise),
    })
    await controller.load()
    face.openInstall()
    face.editInstallSpec('x')
    face.runInstall()
    face.setEnabled(BUNDLE.name, true)
    const before = state()
    controller.dispose()
    enableGate.resolve(ok({ changed: true, effect: 'live' }))
    installGate.resolve(ok({ installed: [], removed: [], enabled: [], installedOnly: [], plain: [], jobId: 'j' }))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(state()).toBe(before)
    await controller.load()
    expect(state()).toBe(before)
    face.setEnabled(BUNDLE.name, false)
    expect(state()).toBe(before)
  })

  it('drops a read that settles after disposal', async () => {
    const gate = deferred<ReturnType<typeof ok<PluginPackageView[]>>>()
    const { state, controller } = bench({ list: vi.fn().mockReturnValueOnce(gate.promise) })
    const loading = controller.load()
    await Promise.resolve()
    const before = state()
    controller.dispose()
    gate.resolve(ok([BUNDLE]))
    await loading
    expect(state()).toBe(before)
  })

  it('reports a thrown enable failure after disposal to nobody', async () => {
    const enableGate = deferred<never>()
    const { face, state, controller } = bench({ enable: vi.fn().mockReturnValueOnce(enableGate.promise) })
    await controller.load()
    face.setEnabled(BUNDLE.name, true)
    const before = state()
    controller.dispose()
    enableGate.resolve(refused('gateway/internal', 'late') as never)
    await Promise.resolve()
    await Promise.resolve()
    expect(state()).toBe(before)
  })

  it('keeps a streamed log that already ends with the Host reason', async () => {
    const { face, state, controller } = bench({
      add: vi.fn().mockResolvedValueOnce(refused('plugins/install-failed', 'exit 1', { spec: 'x', exitCode: 1, log: 'same tail' })),
    })
    await controller.load()
    face.openInstall()
    face.editInstallSpec('x')
    face.runInstall()
    controller.appendLog({ jobId: 'j', spec: 'x', stream: 'stderr', text: 'same tail' })
    await vi.waitFor(() => { expect(state().install.phase).toBe('failed') })
    expect(state().install.log).toBe('same tail')
  })
})
