/**
 * The manager store: what it reads, how actions cross the wire, which
 * failures become notices, and how the install run folds its output.
 */

import { describe, expect, it, vi } from 'vitest'
import type { PluginPackageView } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { type InstallState, PluginManagerController, rowKey } from '../src/client/manager-store.ts'

const BUNDLE: PluginPackageView = {
  name: 'dsh-better-sidebar',
  version: '0.16.0',
  kind: 'bundle',
  installed: true,
  enabled: false,
  status: 'disabled',
  cordisSameCopy: true,
  rows: [],
  overrides: [],
  liveReload: true,
}

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
    cancelInstall: vi.fn(() => Promise.resolve(ok({ status: 'cancelled' }))),
    uninstall: vi.fn(() => Promise.resolve(ok(undefined))),
    enable: vi.fn(() => Promise.resolve(ok({ changed: true, effect: 'live' }))),
    disable: vi.fn(() => Promise.resolve(ok({ changed: true, effect: 'restart' }))),
    retry: vi.fn(() => Promise.resolve(ok({ changed: true, effect: 'live' }))),
    setRowDisabled: vi.fn(() => Promise.resolve(ok(undefined))),
    dependents: vi.fn(() => Promise.resolve(ok({ services: [], references: [] }))),
    ...overrides,
  }
  const ctx = { remote: { plugins } } as never
  const controller = new PluginManagerController(ctx)
  const face = controller.inject()
  return { plugins, controller, face, state: () => controller.getSnapshot() }
}

function installationRequest(controller: PluginManagerController): Pick<InstallState, 'requestId'> {
  const requestId = controller.getSnapshot().install.requestId
  return requestId === undefined ? {} : { requestId }
}

describe('PluginManagerController', () => {
  it('starts idle, reads packages on first use, and folds concurrent loads', async () => {
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
    expect(state()).toMatchObject({ status: 'ready', packages: [BUNDLE] })
    face.ensure()
    expect(plugins.list).toHaveBeenCalledTimes(2)
    face.refresh()
    await controller.load()
    expect(plugins.list).toHaveBeenCalledTimes(3)
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
    // The switch is inert while the Host is asked; the dialog opens only with the answer in hand.
    expect(state().busy).toEqual([BUNDLE.name])
    expect(state().confirm).toBeNull()
    await vi.waitFor(() => { expect(state().confirm?.dependents?.services).toHaveLength(1) })
    expect(state().confirm).toMatchObject({ action: 'disable', packageName: BUNDLE.name })
    expect(state().busy).toEqual([])
    face.confirm()
    expect(state().confirm).toBeNull()
    await vi.waitFor(() => { expect(plugins.disable).toHaveBeenCalledTimes(2) })
  })

  it('asks before switching a row off only when other rows inject what it provides', async () => {
    const services = [
      { service: 'authorization', providedBy: 'include:seam', injectedBy: ['include:oauth'] },
      { service: 'other', providedBy: 'include:elsewhere', injectedBy: ['include:x'] },
    ]
    const { plugins, face, state, controller } = bench({ dependents: vi.fn(() => Promise.resolve(ok({ services, references: [] }))) })
    await controller.load()
    face.disableRow(BUNDLE.name, 'include:seam', 'seam')
    // The row is inert while the Host is asked, and no dialog opens before the answer.
    expect(state().busy).toEqual([rowKey('seam')])
    expect(state().confirm).toBeNull()
    // Of the package's dependents, only the services this row provides are the row's.
    await vi.waitFor(() => {
      expect(state().confirm).toEqual({ action: 'disableRow', packageName: BUNDLE.name, rowId: 'seam', dependents: { services: [services[0]], references: [] } })
    })
    expect(plugins.setRowDisabled).not.toHaveBeenCalled()
    face.confirm()
    await vi.waitFor(() => { expect(plugins.setRowDisabled).toHaveBeenCalledWith('seam', true) })
    await vi.waitFor(() => { expect(state().busy).toEqual([]) })
    // A row nothing depends on switches off without asking; so does one whose dependents the Host refused to name.
    face.disableRow(BUNDLE.name, 'include:lonely', 'lonely')
    await vi.waitFor(() => { expect(plugins.setRowDisabled).toHaveBeenCalledWith('lonely', true) })
    expect(state().confirm).toBeNull()
    plugins.dependents.mockResolvedValueOnce(refused('gateway/internal', 'boom') as never)
    face.disableRow(BUNDLE.name, 'include:unknown', 'unknown')
    await vi.waitFor(() => { expect(plugins.setRowDisabled).toHaveBeenCalledWith('unknown', true) })
    expect(state().confirm).toBeNull()
    // A check that fails on the wire does not stand between the person and the switch.
    plugins.dependents.mockRejectedValueOnce(new Error('down'))
    face.disableRow(BUNDLE.name, 'include:offline', 'offline')
    await vi.waitFor(() => { expect(plugins.setRowDisabled).toHaveBeenCalledWith('offline', true) })
    expect(state().confirm).toBeNull()
  })

  it('drops a row ask whose answer arrives after disposal, and refuses a second ask while one is in flight', async () => {
    const gate = deferred<ReturnType<typeof ok<{ services: never[]; references: never[] }>>>()
    const { plugins, face, state, controller } = bench({ dependents: vi.fn().mockReturnValueOnce(gate.promise) })
    await controller.load()
    face.disableRow(BUNDLE.name, 'include:seam', 'seam')
    face.disableRow(BUNDLE.name, 'include:seam', 'seam')
    expect(plugins.dependents).toHaveBeenCalledTimes(1)
    controller.dispose()
    gate.resolve(ok({ services: [], references: [] }))
    await Promise.resolve()
    await Promise.resolve()
    expect(state().confirm).toBeNull()
    expect(plugins.setRowDisabled).not.toHaveBeenCalled()
  })

  it('always asks before uninstalling, and cancelling runs nothing', async () => {
    const { plugins, face, state, controller } = bench()
    await controller.load()
    // A check that fails on the wire still leaves the dialog open, with nothing to name.
    plugins.dependents.mockRejectedValueOnce(new Error('down'))
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
    await vi.waitFor(() => { expect(state().busy).toEqual([]) })
    // Success shows in the re-read list, not as a notice.
    expect(state().notice).toBeNull()
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

  it('retries and switches rows under their own busy keys', async () => {
    const { plugins, face, state, controller } = bench()
    await controller.load()
    face.retry(BUNDLE.name)
    await vi.waitFor(() => { expect(plugins.retry).toHaveBeenCalledWith(BUNDLE.name) })
    await vi.waitFor(() => { expect(state().busy).toEqual([]) })
    expect(state().notice).toBeNull()

    face.setRowDisabled('bash', true)
    expect(state().busy).toEqual([rowKey('bash')])
    await vi.waitFor(() => { expect(plugins.setRowDisabled).toHaveBeenCalledWith('bash', true) })
    await vi.waitFor(() => { expect(state().busy).toEqual([]) })

  })

  it('reports thrown row transport failures using the row id', async () => {
    const { face, state, controller } = bench({
      setRowDisabled: vi.fn().mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce('plain text'),
    })
    await controller.load()
    face.setRowDisabled('r', true)
    await vi.waitFor(() => {
      expect(state().notice).toEqual({ kind: 'failed', code: 'gateway/internal', reason: 'offline', rowId: 'r' })
    })
    face.setRowDisabled('r', true)
    await vi.waitFor(() => { expect(state().notice).toMatchObject({ reason: 'plain text' }) })
  })

  it('waits for Host cancellation and ignores the old add reply after a retry starts', async () => {
    const first = deferred<ReturnType<typeof refused>>()
    const second = deferred<ReturnType<typeof ok<InstallValue>>>()
    const cancellation = deferred<ReturnType<typeof ok<{ status: 'cancelled' }>>>()
    const { plugins, face, state, controller } = bench({
      add: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
      cancelInstall: vi.fn().mockReturnValueOnce(cancellation.promise),
    })
    face.openInstall(); face.editInstallSpec('slow'); face.runInstall()
    const requestId = state().install.requestId as NonNullable<InstallState['requestId']>
    face.cancelInstall()
    expect(plugins.cancelInstall).not.toHaveBeenCalled()
    controller.installProgress({ requestId, phase: 'installing' })
    face.cancelInstall(); face.cancelInstall(); face.closeInstall(); face.openInstall()
    expect(plugins.cancelInstall).toHaveBeenCalledExactlyOnceWith(requestId)
    expect(state().install).toMatchObject({ phase: 'cancelling', open: true, spec: 'slow' })
    controller.installProgress({ requestId, phase: 'installing' })
    controller.installProgress({ requestId, phase: 'cancelling' })
    expect(state().install.phase).toBe('cancelling')
    cancellation.resolve(ok({ status: 'cancelled' }))
    await vi.waitFor(() => { expect(state().install.phase).toBe('cancelled') })
    face.runInstall()
    const nextId = state().install.requestId
    expect(nextId).not.toBe(requestId)
    first.resolve(refused('plugins/install-cancelled', 'cancelled', { requestId }))
    await Promise.resolve(); await Promise.resolve()
    expect(state().install).toMatchObject({ requestId: nextId, phase: 'starting' })
    controller.installProgress({ requestId, phase: 'applying' })
    controller.appendLog({ requestId, jobId: 'old', argv: [], cwd: '/p', spec: 'slow', stream: 'stdout', text: 'late' })
    expect(state().install.runs).toEqual([])
    second.resolve(ok({ installed: [], removed: [], enabled: [], installedOnly: [], plain: [], jobId: 'new' }))
    await vi.waitFor(() => { expect(state().install.phase).toBe('done') })
    controller.installProgress({ requestId: nextId as typeof requestId, phase: 'installing' })
    expect(state().install.phase).toBe('done')
  })

  it.each(['too-late', 'not-running', 'offline'] as const)('keeps cancellation %s distinct from a stopped installation', async (status) => {
    const pending = deferred<ReturnType<typeof refused>>()
    const { plugins, face, state, controller } = bench({
      add: vi.fn().mockReturnValue(pending.promise),
      cancelInstall: vi.fn().mockResolvedValue(status === 'offline' ? refused('gateway/internal', 'offline') : ok({ status })),
    })
    face.openInstall(); face.editInstallSpec('slow'); face.runInstall()
    const requestId = state().install.requestId as NonNullable<InstallState['requestId']>
    controller.installProgress({ requestId, phase: 'installing' })
    face.cancelInstall()
    await vi.waitFor(() => { expect(state().install.phase).toBe(status === 'too-late' ? 'applying' : 'running') })
    expect(state().install.phase).not.toBe('cancelled')
    expect(plugins.cancelInstall).toHaveBeenCalledOnce()
    pending.resolve(refused('plugins/install-cancelled', 'cancelled', { requestId }))
    await vi.waitFor(() => { expect(state().install.phase).toBe('cancelled') })
    expect(state().install.failure).toBeNull()
  })

  it.each([false, true])('drops a cancellation response after the add settles or the page is disposed (%s)', async (dispose) => {
    const answer = deferred<ReturnType<typeof ok<InstallValue>>>()
    const cancellation = deferred<ReturnType<typeof ok<{ status: 'cancelled' }>>>()
    const { face, state, controller } = bench({
      add: vi.fn().mockReturnValue(answer.promise), cancelInstall: vi.fn().mockReturnValue(cancellation.promise),
    })
    face.openInstall(); face.editInstallSpec('slow'); face.runInstall()
    controller.installProgress({ requestId: state().install.requestId as NonNullable<InstallState['requestId']>, phase: 'installing' })
    face.cancelInstall()
    if (dispose) controller.dispose()
    answer.resolve(ok({ installed: [], removed: [], enabled: [], installedOnly: [], plain: [], jobId: 'j' }))
    if (!dispose) await vi.waitFor(() => { expect(state().install.phase).toBe('done') })
    const before = state()
    cancellation.resolve(ok({ status: 'cancelled' }))
    await Promise.resolve(); await Promise.resolve()
    expect(state()).toBe(before)
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
    expect(plugins.add).toHaveBeenCalledWith('dsh-better-sidebar', { enable: false, requestId: state().install.requestId })
    expect(state().install.phase).toBe('starting')
    face.closeInstall()
    expect(state().install.open).toBe(true)
    const argv = ['pnpm', 'add', 'dsh-better-sidebar']
    controller.appendLog({ ...installationRequest(controller), jobId: 'j1', argv, cwd: '/p', spec: 'dsh-better-sidebar', stream: 'stdout', text: 'Progress\n' })
    // The Host's second pnpm run — removing a rejected package, under that
    // package's name — is a run of its own, and a later chunk lands on the
    // run it names.
    controller.appendLog({ ...installationRequest(controller), jobId: 'jr', argv: ['pnpm', 'remove', 'lib'], cwd: '/p', spec: 'lib', stream: 'stdout', text: '- lib\n', exitCode: 0 })
    controller.appendLog({ ...installationRequest(controller), jobId: 'j1', argv, cwd: '/p', spec: 'dsh-better-sidebar', stream: 'stdout', text: 'Done\n' })
    expect(state().install.runs).toEqual([
      { jobId: 'j1', command: 'pnpm add dsh-better-sidebar', cwd: '/p', output: 'Progress\nDone\n' },
      { jobId: 'jr', command: 'pnpm remove lib', cwd: '/p', output: '- lib\n', exitCode: 0 },
    ])
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
    // The finished install settled its run; a trailing last chunk still lands
    // on it, while a chunk for a run the dialog never saw is dropped.
    controller.appendLog({ ...installationRequest(controller), jobId: 'j1', argv, cwd: '/p', spec: 'dsh-better-sidebar', stream: 'stdout', text: 'late', exitCode: 0 })
    controller.appendLog({ ...installationRequest(controller), jobId: 'j3', argv, cwd: '/p', spec: 'dsh-better-sidebar', stream: 'stdout', text: 'stray' })
    expect(state().install.runs).toEqual([
      { jobId: 'j1', command: 'pnpm add dsh-better-sidebar', cwd: '/p', output: 'Progress\nDone\nlate', exitCode: 0 },
      { jobId: 'jr', command: 'pnpm remove lib', cwd: '/p', output: '- lib\n', exitCode: 0 },
    ])
    await vi.waitFor(() => { expect(plugins.list).toHaveBeenCalledTimes(2) })
    // A new spec after the finished run starts over, keeping the enable choice.
    face.editInstallSpec('another')
    expect(state().install).toMatchObject({ phase: 'idle', spec: 'another', enable: false, runs: [], installed: [] })
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

  it('keeps the Host reason of a failed install and settles a run whose last chunk never came', async () => {
    const { face, state, controller, plugins } = bench({
      add: vi.fn()
        .mockResolvedValueOnce(refused('plugins/install-failed', 'exit 1', { spec: 'x', exitCode: 1, log: 'ERR_PNPM' }))
        .mockResolvedValueOnce(refused('gateway/internal', 'offline'))
        .mockResolvedValueOnce(refused('plugins/install-failed', 'killed', { spec: 'x', exitCode: null, log: 'tail' }))
        .mockResolvedValueOnce(refused('plugins/enable-failed', 'plugin-manager: x rejected', { packageName: 'x', reason: 'the tree rejected it' }))
        .mockResolvedValueOnce(refused('plugins/install-failed', 'exit 1', { spec: 'x' }))
        .mockResolvedValueOnce(refused('plugins/install-failed', 'exit 1', { spec: 'x', exitCode: 'one' })),
    })
    const argv = ['pnpm', 'add', 'x']
    await controller.load()
    face.openInstall()
    face.editInstallSpec('x')
    // No chunk arrived: the Host's captured tail is the reason, and there is no run.
    face.runInstall()
    await vi.waitFor(() => { expect(state().install.phase).toBe('failed') })
    expect(state().install.runs).toEqual([])
    expect(state().install.failure).toEqual({ code: 'plugins/install-failed', reason: 'ERR_PNPM' })
    face.runInstall()
    await vi.waitFor(() => { expect(plugins.add).toHaveBeenCalledTimes(2) })
    await vi.waitFor(() => { expect(state().install.failure).toEqual({ code: 'gateway/internal', reason: 'offline' }) })
    // A pnpm failure settles the open run with the code the answer names — here none.
    face.runInstall()
    controller.appendLog({ ...installationRequest(controller), jobId: 'j', argv, cwd: '/p', spec: 'x', stream: 'stderr', text: 'streamed' })
    await vi.waitFor(() => { expect(plugins.add).toHaveBeenCalledTimes(3) })
    await vi.waitFor(() => { expect(state().install.phase).toBe('failed') })
    expect(state().install.runs).toEqual([{ jobId: 'j', command: 'pnpm add x', cwd: '/p', output: 'streamed', exitCode: null }])
    expect(state().install.failure).toEqual({ code: 'plugins/install-failed', reason: 'tail' })
    // A refusal after pnpm means pnpm itself exited 0.
    face.runInstall()
    controller.appendLog({ ...installationRequest(controller), jobId: 'j', argv, cwd: '/p', spec: 'x', stream: 'stdout', text: 'Done' })
    await vi.waitFor(() => { expect(plugins.add).toHaveBeenCalledTimes(4) })
    await vi.waitFor(() => { expect(state().install.phase).toBe('failed') })
    expect(state().install.runs).toEqual([{ jobId: 'j', command: 'pnpm add x', cwd: '/p', output: 'Done', exitCode: 0 }])
    expect(state().install.failure).toEqual({ code: 'plugins/enable-failed', reason: 'the tree rejected it' })
    // Details without an exit code settle the run as having none.
    face.runInstall()
    controller.appendLog({ ...installationRequest(controller), jobId: 'j', argv, cwd: '/p', spec: 'x', stream: 'stdout', text: 'partial' })
    await vi.waitFor(() => { expect(plugins.add).toHaveBeenCalledTimes(5) })
    await vi.waitFor(() => { expect(state().install.phase).toBe('failed') })
    expect(state().install.runs).toEqual([{ jobId: 'j', command: 'pnpm add x', cwd: '/p', output: 'partial', exitCode: null }])
    // So does an exit code the answer types wrongly.
    face.runInstall()
    controller.appendLog({ ...installationRequest(controller), jobId: 'j', argv, cwd: '/p', spec: 'x', stream: 'stdout', text: 'odd' })
    await vi.waitFor(() => { expect(plugins.add).toHaveBeenCalledTimes(6) })
    await vi.waitFor(() => { expect(state().install.phase).toBe('failed') })
    expect(state().install.runs).toEqual([{ jobId: 'j', command: 'pnpm add x', cwd: '/p', output: 'odd', exitCode: null }])
    // Editing the spec after a failure starts over too.
    face.editInstallSpec('y')
    expect(state().install).toMatchObject({ phase: 'idle', spec: 'y', runs: [], failure: null })
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

  it('leaves a run its own exit code when its last chunk beat the answer', async () => {
    const { face, state, controller } = bench({
      add: vi.fn().mockResolvedValueOnce(refused('plugins/install-failed', 'exit 1', { spec: 'x', exitCode: 1, log: 'same tail' })),
    })
    await controller.load()
    face.openInstall()
    face.editInstallSpec('x')
    face.runInstall()
    controller.appendLog({ ...installationRequest(controller), jobId: 'j', argv: ['pnpm', 'add', 'x'], cwd: '/p', spec: 'x', stream: 'stderr', text: 'same tail' })
    controller.appendLog({ ...installationRequest(controller), jobId: 'j', argv: ['pnpm', 'add', 'x'], cwd: '/p', spec: 'x', stream: 'stdout', text: '', exitCode: 1 })
    await vi.waitFor(() => { expect(state().install.phase).toBe('failed') })
    expect(state().install.runs).toEqual([{ jobId: 'j', command: 'pnpm add x', cwd: '/p', output: 'same tail', exitCode: 1 }])
  })
})
