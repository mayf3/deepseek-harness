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
  PluginOperationError, type PluginManager, type PluginOperationFailure, type SpawnLike,
} from '@deepseek-ai/dsh-plugin-manager'
import PluginManagerRemote, { remoteErrorOf, type Config } from '@deepseek-ai/dsh-host-plugin-manager'
import type {} from '@deepseek-ai/dsh-host-plugin-manager/types'

/** A complete config: the schema fills defaults at load, the type does not. */
const CONFIG: Config = { pnpmCommand: 'pnpm', installTimeoutMs: 1_000, installLogTailBytes: 16_384 }

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

  it('publishes the plugins namespace with one direct method per operation', async () => {
    const remote = await mount()
    expect(remote.typertRemote).toMatchObject({ serviceKey: 'pluginManager', namespace: 'plugins' })
    expect(remoteMethods(remote).map(marker => marker.method)).toEqual([
      'list', 'add', 'uninstall', 'enable', 'disable', 'retry', 'addRow', 'removeRow', 'setRowDisabled', 'dependents',
    ])
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
    await remote.uninstall('pkg')
    await remote.enable('pkg')
    await remote.disable('pkg')
    await remote.retry('pkg')
    await remote.addRow('pkg', { kind: 'global' }, { module: './x.js', id: 'x', config: { a: 1 } })
    await remote.removeRow({ kind: 'preset', preset: 'standard' }, 'x')
    await remote.setRowDisabled({ kind: 'global' }, 'x', true)
    await remote.dependents('pkg')

    expect(calls).toEqual([
      ['list'],
      ['add', 'spec', { enable: true }],
      ['uninstall', 'pkg'],
      ['enable', 'pkg'],
      ['disable', 'pkg'],
      ['retry', 'pkg'],
      ['addRow', 'pkg', { kind: 'global' }, { module: './x.js', id: 'x', config: { a: 1 } }],
      ['removeRow', { kind: 'preset', preset: 'standard' }, 'x'],
      ['setRowDisabled', { kind: 'global' }, 'x', true],
      ['dependents', 'pkg'],
    ])
  })

  it('hands the manager readers into the context: the runtime, the agent count, the roster, and the seams', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-host-plugin-manager-'))
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web', private: true, dependencies: { pkg: '1.0.0' }, dsh: { profile: { bundles: [], patchReload: 'startup' } },
    }))
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Loader)
    ctx.provide('profileRuntime', {
      dir: profileDir, profileName: 'web', installAnchor: join(profileDir, 'package.json'), patchReload: 'startup', current: { layers: [] },
    } as never)
    const metadata: typeof readPackageMetadata = options => ({
      packageName: options.packageName, kind: 'plugin', cordisSameCopy: null, rows: [], overrides: [], addable: [{ name: '.' }],
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
      // The static reader answers for the package, then the roster reader finds no roster for a preset target.
      await expect(remote.addRow('pkg', { kind: 'preset', preset: 'standard' })).rejects.toMatchObject({ code: 'plugins/unavailable', details: { reason: 'no roster' } })
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
      new PluginOperationError('plugins/install-failed', 'm', { spec: 's', exitCode: 1, log: 'l' }),
      new PluginOperationError('plugins/row-conflict', 'm', { rowId: 'x', target: { kind: 'global' } }),
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
    const error = new RemoteError('plugins/row-conflict', 'taken', { rowId: 'x', target: { kind: 'global' } })
    expect(error.details).toEqual({ rowId: 'x', target: { kind: 'global' } })
  })
})
