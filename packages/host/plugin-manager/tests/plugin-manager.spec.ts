/**
 * The `plugins` Remote as a relay: every method reaches the shared manager
 * with its arguments, a manager failure crosses as the Remote error of the
 * same code, and a composition without a profile runtime still mounts the
 * service. What the manager does is pinned in `dsh-plugin-manager`'s own
 * tests over a real profile.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { readPackageMetadata } from '@deepseek-ai/dsh-app-boot'
import { remoteMethods, RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import {
  PluginOperationError, type PluginManager, type PluginOperationFailure, type SpawnLike, type PluginInstallRequestId,
} from '@deepseek-ai/dsh-plugin-manager'
import PluginManagerRemote, { remoteErrorOf, type Config } from '@deepseek-ai/dsh-host-plugin-manager'
import type {} from '@deepseek-ai/dsh-host-plugin-manager/types'

/** A complete config: the schema fills defaults at load, the type does not. */
const CONFIG: Config = { pnpmCommand: 'pnpm', installTimeoutMs: 1_000, installKillGraceMs: 50, installLogTailBytes: 16_384 }

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** Mount the Remote on a bare Loader context, over the given manager or the default one. */
async function mount(manager?: PluginManager): Promise<PluginManagerRemote> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader)
  class TestRemote extends PluginManagerRemote {
    constructor(context: Context, config: Config) {
      super(context, config, manager === undefined ? {} : { manager })
    }
  }
  await ctx.plugin(TestRemote, CONFIG)
  const service = ctx.get('pluginManager')
  if (service === undefined) throw new Error('the Remote did not mount')
  return service
}

describe('PluginManagerRemote', () => {
  it('waits for queued profile recomposition before publishing changed issues', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Loader)
    ctx.loader.builtins.good = { inject: ['missingService'], apply() {} }
    const id = await ctx.loader.create({ name: 'cordis:good' })
    await ctx.plugin(PluginManagerRemote, CONFIG)
    await new Promise<void>(resolve => setImmediate(resolve))
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const whenIdle = vi.fn(() => gate)
    ctx.provide('profileRuntime', { whenIdle } as never)
    const changes: string[] = []
    ctx.on('plugins/changed', ({ reason }) => { changes.push(reason) })
    ctx.provide('missingService', {})
    ctx.emit('loader/entry-init', ctx.loader.resolve(id))
    try {
      await vi.waitFor(() => { expect(whenIdle).toHaveBeenCalledOnce() })
      expect(changes).toEqual([])
    } finally { release() }
    await vi.waitFor(() => { expect(changes).toEqual(['runtime']) })
  })

  it('reports a failed refresh and cancels publication when disposed during settlement', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Loader)
    ctx.loader.builtins.good = () => {}
    const id = await ctx.loader.create({ name: 'cordis:good' })
    const entry = ctx.loader.resolve(id)
    const remote = ctx.plugin(PluginManagerRemote, CONFIG)
    await remote
    const changes: string[] = []
    ctx.on('plugins/changed', ({ reason }) => { changes.push(reason) })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const settle = vi.spyOn(ctx.loader, 'await').mockRejectedValueOnce(new Error('settlement unavailable'))
    try {
      ctx.emit('loader/entry-init', entry)
      await vi.waitFor(() => { expect(warn).toHaveBeenCalled() })
      let enter!: () => void
      const entered = new Promise<void>((resolve) => { enter = resolve })
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      settle.mockImplementationOnce(async () => { enter(); await gate })
      ctx.emit('loader/entry-init', entry)
      await entered
      try {
        await remote.dispose()
      } finally { release() }
      await Promise.resolve()
      expect(changes).toEqual([])
    } finally {
      settle.mockRestore()
      warn.mockRestore()
    }
  })

  it('announces Loader dependency recovery and stops publishing after the Remote is disposed', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Loader)
    const changes: string[] = []
    ctx.on('plugins/changed', ({ reason }) => { changes.push(reason) })
    const remote = ctx.plugin(PluginManagerRemote, CONFIG)
    await remote
    ctx.loader.builtins.waiting = { inject: ['lateService'], apply() {} }
    const id = await ctx.loader.create({ name: 'cordis:waiting' })
    await vi.waitFor(() => { expect(changes).toContain('runtime') })
    expect(ctx.loader.resolve(id).fiber?.state).toBe(0)
    changes.length = 0
    ctx.provide('lateService', {})
    await vi.waitFor(() => {
      expect(ctx.loader.resolve(id).fiber?.state).toBe(2)
      expect(changes).toContain('runtime')
    })
    await remote.dispose()
    const count = changes.length
    await ctx.loader.resolve(id).update({ disabled: true })
    await ctx.loader.await()
    expect(changes).toHaveLength(count)
  })

  it('keeps unrelated healthy changes and unchanged errors silent, but reports error changes and recovery', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Loader)
    ctx.loader.builtins.good = () => {}
    const id = await ctx.loader.create({ name: 'cordis:good' })
    const entry = ctx.loader.resolve(id)
    const changes: string[] = []
    ctx.on('plugins/changed', ({ reason }) => { changes.push(reason) })
    await ctx.plugin(PluginManagerRemote, CONFIG)
    await new Promise<void>(resolve => setImmediate(resolve))
    await entry.update({ config: { healthy: true } })
    await ctx.loader.await()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(changes).toEqual([])

    entry.lastFailure = { stage: 'update', error: 'first update failed' }
    ctx.emit('loader/entry-init', entry)
    await vi.waitFor(() => { expect(changes).toEqual(['runtime']) })
    ctx.emit('loader/entry-init', entry)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(changes).toEqual(['runtime'])
    entry.lastFailure = { stage: 'update', error: 'different update failed' }
    ctx.emit('loader/entry-init', entry)
    await vi.waitFor(() => { expect(changes).toEqual(['runtime', 'runtime']) })
    delete entry.lastFailure
    ctx.emit('loader/entry-init', entry)
    await vi.waitFor(() => { expect(changes).toEqual(['runtime', 'runtime', 'runtime']) })
  })

  it('shares one pending refresh across a burst of Loader events', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Loader)
    ctx.loader.builtins.waiting = { inject: ['lateService'], apply() {} }
    const id = await ctx.loader.create({ name: 'cordis:waiting' })
    const entry = ctx.loader.resolve(id)
    const changes: string[] = []
    ctx.on('plugins/changed', ({ reason }) => { changes.push(reason) })
    await ctx.plugin(PluginManagerRemote, CONFIG)
    await vi.waitFor(() => { expect(changes).toEqual(['runtime']) })
    const gate = Promise.withResolvers<undefined>()
    const whenIdle = vi.fn(() => gate.promise)
    ctx.provide('profileRuntime', { whenIdle } as never)
    const settle = vi.spyOn(ctx.loader, 'await')
    try {
      ctx.emit('loader/entry-init', entry)
      await vi.waitFor(() => { expect(whenIdle).toHaveBeenCalledOnce() })
      for (let i = 0; i < 100; i++) ctx.emit('loader/entry-init', entry)
      expect(settle).toHaveBeenCalledOnce()
      expect(whenIdle).toHaveBeenCalledOnce()
      ctx.provide('lateService', {})
      gate.resolve(undefined)
      await vi.waitFor(() => { expect(changes).toEqual(['runtime', 'runtime']) })
      expect(entry.fiber?.state).toBe(2)
    } finally {
      gate.resolve(undefined)
      settle.mockRestore()
    }
  })

  it('discards a diagnostic snapshot changed while it was being read', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Loader)
    ctx.loader.builtins.good = () => {}
    const id = await ctx.loader.create({ name: 'cordis:good' })
    const entry = ctx.loader.resolve(id)
    await ctx.plugin(PluginManagerRemote, CONFIG)
    await new Promise<void>(resolve => setImmediate(resolve))
    const changes: string[] = []
    ctx.on('plugins/changed', ({ reason }) => { changes.push(reason) })
    entry.lastFailure = { stage: 'update', error: new Error('transient failure') }
    const read = vi.spyOn(entry, 'disabled', 'get').mockImplementationOnce(() => {
      queueMicrotask(() => {
        delete entry.lastFailure
        ctx.emit('loader/entry-init', entry)
      })
      return false
    })
    try {
      ctx.emit('loader/entry-init', entry)
      await vi.waitFor(() => { expect(read).toHaveBeenCalledTimes(2) })
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(changes).toEqual([])
    } finally {
      read.mockRestore()
    }
  })

  it('cancels publication when disposed during the diagnostic read', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Loader)
    ctx.loader.builtins.good = () => {}
    const id = await ctx.loader.create({ name: 'cordis:good' })
    const entry = ctx.loader.resolve(id)
    const remote = ctx.plugin(PluginManagerRemote, CONFIG)
    await remote
    await new Promise<void>(resolve => setImmediate(resolve))
    const changes: string[] = []
    ctx.on('plugins/changed', ({ reason }) => { changes.push(reason) })
    entry.lastFailure = { stage: 'update', error: new Error('update failed') }
    const disposed = Promise.withResolvers<undefined>()
    const read = vi.spyOn(entry, 'disabled', 'get').mockImplementationOnce(() => {
      queueMicrotask(() => { void remote.dispose().then(() => { disposed.resolve(undefined) }, disposed.reject) })
      return false
    })
    try {
      ctx.emit('loader/entry-init', entry)
      await disposed.promise
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(changes).toEqual([])
    } finally {
      read.mockRestore()
    }
  })

  it('publishes the plugins namespace with one direct method per operation', async () => {
    const remote = await mount()
    expect(remote.typertRemote).toMatchObject({ serviceKey: 'pluginManager', namespace: 'plugins' })
    expect(remoteMethods(remote).map(marker => marker.method)).toEqual([
      'list', 'add', 'cancelInstall', 'uninstall', 'enable', 'disable', 'retry', 'setRowDisabled', 'dependents',
    ])
  })

  it('rejects malformed cancellation ids without running a manager operation', async () => {
    const remote = await mount()
    await expect(remote.cancelInstall('not-an-id' as PluginInstallRequestId)).rejects.toMatchObject({ code: 'gateway/bad-request' })
    await expect(remote.add('pkg', { requestId: 'not-an-id' as PluginInstallRequestId })).rejects.toMatchObject({ code: 'gateway/bad-request' })
    await expect(remote.cancelInstall('f2340b6d-40bb-46b7-8b94-217bdf5010bd' as PluginInstallRequestId)).resolves.toEqual({ status: 'not-running' })
  })

  it('mounts without a profile runtime and reports plugins/unavailable as a Remote error', async () => {
    const remote = await mount()
    await expect(remote.list()).rejects.toMatchObject({ isDSHRemoteError: true, code: 'plugins/unavailable', details: { reason: 'no profile runtime' } })
  })

  it('relays every operation to the manager with its arguments and answer', async () => {
    const calls: unknown[][] = []
    const stub = new Proxy({}, {
      get: (_target, method: string) => (...args: unknown[]) => {
        calls.push([method, ...args])
        return Promise.resolve({ method })
      },
    }) as PluginManager
    const remote = await mount(stub)

    await expect(remote.list()).resolves.toEqual({ method: 'list' })
    await remote.add('spec', { enable: true })
    await remote.cancelInstall('f2340b6d-40bb-46b7-8b94-217bdf5010bd' as PluginInstallRequestId)
    await remote.uninstall('pkg')
    await remote.enable('pkg')
    await remote.disable('pkg')
    await remote.retry('pkg')
    await remote.setRowDisabled('x', true)
    await remote.dependents('pkg')

    expect(calls).toEqual([
      ['list'],
      ['add', 'spec', { enable: true }],
      ['cancelInstall', 'f2340b6d-40bb-46b7-8b94-217bdf5010bd'],
      ['uninstall', 'pkg'],
      ['enable', 'pkg'],
      ['disable', 'pkg'],
      ['retry', 'pkg'],
      ['setRowDisabled', 'x', true],
      ['dependents', 'pkg'],
    ])
  })

  it('hands the manager readers into the context: the runtime, the agent count, and the seams', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-host-plugin-manager-'))
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web', private: true, dependencies: { pkg: '1.0.0' }, dsh: { profile: { bundles: [], patchReload: 'startup' } },
    }))
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Loader)
    ctx.provide('profileRuntime', {
      dir: profileDir, profileName: 'web', installAnchor: join(profileDir, 'package.json'), patchReload: 'startup', current: { layers: [] },
      whenIdle: async () => {},
    } as never)
    const metadata: typeof readPackageMetadata = options => ({
      packageName: options.packageName, kind: 'unknown', cordisSameCopy: null, rows: [], overrides: [],
    })
    const spawn: SpawnLike = () => { throw new Error('this test spawns nothing') }
    class SeamedRemote extends PluginManagerRemote {
      constructor(context: Context, config: Config) {
        super(context, config, { spawn, metadata })
      }
    }
    await ctx.plugin(SeamedRemote, CONFIG)
    const remote = ctx.get('pluginManager')
    if (remote === undefined) throw new Error('the Remote did not mount')
    try {
      // The runtime reader and the spawn seam: without an agent registry nothing runs, so the install reaches pnpm.
      await expect(remote.add('anything')).rejects.toThrow('this test spawns nothing')
      // The agent-count reader: a running session refuses an install before pnpm runs.
      ctx.provide('agents', { list: () => [{ status: 'running' }, { status: 'idle' }] } as never)
      await expect(remote.add('anything')).rejects.toMatchObject({ code: 'plugins/agents-running', details: { operation: 'add', running: 1 } })
      await expect(remote.enable('pkg')).rejects.toMatchObject({ code: 'plugins/not-enableable' })
    } finally {
      rmSync(profileDir, { recursive: true, force: true })
    }
  })

  it('turns a manager failure into the Remote error of the same code and lets any other error through', async () => {
    const busy = new PluginOperationError('plugins/busy', 'busy', { operation: 'add', subject: 'y', active: { operation: 'add', subject: 'x' } })
    const failing = {
      list: () => Promise.reject(busy),
      add: () => Promise.reject(new Error('the manager broke')),
    } as unknown as PluginManager
    const remote = await mount(failing)

    const error = await remote.list().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(RemoteError)
    expect(error).toMatchObject({ code: 'plugins/busy', message: 'busy', details: busy.details, cause: busy })
    await expect(remote.add('x')).rejects.toThrow('the manager broke')
  })
})

describe('remoteErrorOf', () => {
  it('keeps every plugins/* code with its details and maps the generic refusal to gateway/bad-request', () => {
    const failures: PluginOperationFailure[] = [
      new PluginOperationError('plugins/unavailable', 'm', { reason: 'no profile runtime' }),
      new PluginOperationError('plugins/not-installed', 'm', { packageName: 'p' }),
      new PluginOperationError('plugins/not-enableable', 'm', { packageName: 'p', reason: 'r' }),
      new PluginOperationError('plugins/enable-failed', 'm', { packageName: 'p', reason: 'r' }),
      new PluginOperationError('plugins/install-cancelled', 'm', { requestId: 'f2340b6d-40bb-46b7-8b94-217bdf5010bd' as PluginInstallRequestId }),
      new PluginOperationError('plugins/install-failed', 'm', { spec: 's', exitCode: 1, log: 'l' }),
      new PluginOperationError('plugins/busy', 'm', { operation: 'add', subject: 'y', active: { operation: 'add', subject: 'x' } }),
      new PluginOperationError('plugins/agents-running', 'm', { operation: 'add', running: 1 }),
    ]
    for (const failure of failures) {
      const error = remoteErrorOf(failure)
      expect(error).toBeInstanceOf(RemoteError)
      expect(error).toMatchObject({ code: failure.code, message: 'm', details: failure.details, cause: failure })
    }
    const refused = new PluginOperationError('plugins/bad-request', 'nothing to do', {})
    expect(remoteErrorOf(refused)).toMatchObject({ code: 'gateway/bad-request', message: 'nothing to do', details: {}, cause: refused })
  })
})

describe('RemoteError codes', () => {
  it('declare their details', () => {
    const error = new RemoteError('plugins/not-installed', 'absent', { packageName: 'x' })
    expect(error.details).toEqual({ packageName: 'x' })
  })
})
