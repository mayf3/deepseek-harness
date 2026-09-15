/** Persistent manager behavior through a real profile Include and Loader. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type AgentRegistry from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { expect, it, onTestFinished, vi } from 'vitest'
import {
  boot, composeEntries, initProfile, readProfilePatches, readProfileManifest, reconcileProfilePatches,
  type ProfileContext,
} from '@deepseek-ai/dsh-app-boot'
import PluginManager, { type Config, type PluginChange, type PluginInstallLogChunk, type PluginInstallProgress, type PluginInstallRequestId } from '../src/index.ts'
import Hmr from '@deepseek-ai/dsh-hmr'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { Group } from '@deepseek-ai/cordis-plugin-loader'
import * as operations from '../src/operations.ts'

async function fixture(reload: 'live' | 'startup' = 'live', overlay = false, prepare?: (ctx: Context) => void, config: Config = {}) {
  const home = mkdtempSync(join(tmpdir(), 'plugin-manager-'))
  const dir = join(home, 'profiles', 'test')
  const anchor = join(home, 'package.json')
  writeFileSync(anchor, '{"name":"installation","dependencies":{}}\n')
  initProfile(dir, ['core', 'extra'], reload)
  const bundle = (name: string, rows: unknown[]) => {
    const path = join(dir, 'node_modules', name)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    writeFileSync(join(path, 'cordis.patch.yml'), JSON.stringify([{ insert: rows }]))
    writeFileSync(join(path, 'plugin.mjs'), 'export function apply(ctx, config) { if (config?.fail) throw new Error("test activation failed"); ctx.provide(config?.service ?? "managedProbe", true) }\n')
  }
  bundle('core', [{ id: 'manager', name: 'cordis:manager', config }])
  bundle('extra', [{ id: 'managed', name: './plugin.mjs' }])
  const manifest = readProfileManifest('test', dir)
  manifest.dependencies = { extra: '1.0.0' }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'test',
    startedBundles: ['core', 'extra'],
    dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: anchor, cwd: home, home, patchReload: reload,
    overlays: overlay ? [{ id: 'managed', disabled: true }] : [], telemetryDisabledEnv: undefined,
  }
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (ctx) => {
    prepare?.(ctx)
    ctx.provide('profileContext', profile)
    ctx.loader.builtins.manager = PluginManager
  })
  onTestFinished(async () => { await ctx.fiber.dispose(); rmSync(home, { recursive: true, force: true }) })
  return { ctx, dir, manager: ctx.pluginManager, bundle, profile }
}

it('lists bundle versions and current-profile plugin targets', async () => {
  const { manager, dir } = await fixture()
  const plugins = await manager.listPlugins()
  expect(plugins.find(row => row.entryId === 'include:managed')).toMatchObject({ patchId: 'managed', enabled: true })
  expect(plugins.find(row => row.entryId === 'include:manager')?.readOnlyReason).toBeDefined()
  expect(await manager.listBundles()).toEqual([
    {
      name: 'core', version: '1.0.0', enabled: true, installed: false, removable: false,
      readOnlyReason: 'This bundle provides plugin management components',
      rows: [{ rowId: 'manager', moduleName: 'cordis:manager', entryId: 'include:manager' }], overrides: [],
    },
    {
      name: 'extra', version: '1.0.0', enabled: true, installed: true, removable: true,
      rows: [{ rowId: 'managed', moduleName: pathToFileURL(join(dir, 'node_modules', 'extra', 'plugin.mjs')).href, entryId: 'include:managed' }], overrides: [],
    },
  ])
})

it('describes a bundle by its manifest and patch: title, one-liner, rows without a live entry, and the built-in rows it changes', async () => {
  const { manager, dir, bundle } = await fixture()
  bundle('described', [{ id: 'described-row', name: './plugin.mjs' }])
  writeFileSync(join(dir, 'node_modules', 'described', 'package.json'), JSON.stringify({
    name: 'described', version: '2.0.0', description: 'Describes itself.', dsh: { title: 'Described', bundle: { patch: './cordis.patch.yml' } },
  }))
  // An anonymous row is not addressable and is left out of the rows.
  writeFileSync(join(dir, 'node_modules', 'described', 'cordis.patch.yml'), JSON.stringify([
    { insert: [{ id: 'described-row', name: './plugin.mjs' }, { name: './plugin.mjs' }] }, { id: 'managed', disabled: true }, { id: 'described-row', config: {} },
  ]))
  const manifest = readProfileManifest('test', dir)
  manifest.dependencies = { ...manifest.dependencies, described: '2.0.0' }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  const moduleName = pathToFileURL(join(dir, 'node_modules', 'described', 'plugin.mjs')).href
  expect((await manager.listBundles()).find(row => row.name === 'described')).toEqual({
    name: 'described', version: '2.0.0', title: 'Described', description: 'Describes itself.', enabled: false, installed: true, removable: true,
    rows: [{ rowId: 'described-row', moduleName }], overrides: ['managed'],
  })
  await manager.setBundleEnabled('described', true)
  expect((await manager.listBundles()).find(row => row.name === 'described')?.rows).toEqual([
    { rowId: 'described-row', moduleName, entryId: 'include:described-row' },
  ])
  // Off again, the rows lose their entries.
  await manager.setBundleEnabled('described', false)
  expect((await manager.listBundles()).find(row => row.name === 'described')?.rows).toEqual([{ rowId: 'described-row', moduleName }])
})

it('turns a plugin off and on without duplicating patch overrides', async () => {
  const { manager, dir } = await fixture()
  const id = (await manager.listPlugins()).find(row => row.patchId === 'managed')!.entryId
  expect(await manager.setPluginEnabled(id, false)).toMatchObject({ changed: true, application: 'applied' })
  expect((await manager.listPlugins()).find(row => row.entryId === id)?.enabled).toBe(false)
  expect(await manager.setPluginEnabled(id, false)).toMatchObject({ changed: false, application: 'applied' })
  expect(await manager.setPluginEnabled(id, true)).toMatchObject({ changed: true, application: 'applied' })
  expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8').match(/id: managed/g)).toHaveLength(1)
})

it('retains installed dependencies when toggling a bundle and appends it when re-enabled', async () => {
  const { manager, dir, bundle } = await fixture()
  bundle('third', [])
  await manager.setBundleEnabled('third', true)
  expect(await manager.setBundleEnabled('extra', false)).toMatchObject({ changed: true, application: 'applied' })
  expect(readProfileManifest('test', dir).dependencies).toEqual({ extra: '1.0.0' })
  expect((await manager.listPlugins()).some(row => row.patchId === 'managed')).toBe(false)
  await manager.setBundleEnabled('extra', true)
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual(['core', 'third', 'extra'])
})

it('reports an overlay overriding a saved plugin toggle', async () => {
  const { manager } = await fixture('live', true)
  const id = (await manager.listPlugins()).find(row => row.patchId === 'managed')!.entryId
  expect(await manager.setPluginEnabled(id, true)).toMatchObject({ changed: true, application: 'overridden' })
})

it('saves startup-only toggles and refuses removal of currently used packages', async () => {
  const { manager } = await fixture('startup')
  const id = (await manager.listPlugins()).find(row => row.patchId === 'managed')!.entryId
  expect(await manager.setPluginEnabled(id, false)).toMatchObject({ application: 'restart-required' })
  expect((await manager.listPlugins()).find(row => row.entryId === id)?.enabled).toBe(true)
  await manager.setBundleEnabled('extra', false)
  expect(await manager.removeBundle('extra')).toMatchObject({ changed: false, application: 'failed' })
})

it('refuses self-disable, unknown entries and removal of installation-owned bundles', async () => {
  const { manager } = await fixture()
  const id = (await manager.listPlugins()).find(row => row.entryId === 'include:manager')!.entryId
  expect(await manager.setPluginEnabled(id, false)).toMatchObject({ changed: false, application: 'failed' })
  expect(await manager.setPluginEnabled('missing' as typeof id, true)).toMatchObject({ changed: false, application: 'failed' })
  expect(await manager.removeBundle('core')).toMatchObject({ changed: false, application: 'failed' })
  expect(await manager.setBundleEnabled('unknown', true)).toMatchObject({ changed: false, application: 'failed' })
})

it('installs only valid bundle declarations and honors installation without activation', async () => {
  const { manager, dir, bundle } = await fixture()
  const initial = readProfileManifest('test', dir)
  delete initial.dependencies
  writeFileSync(join(dir, 'package.json'), JSON.stringify(initial))
  const install = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async (_context, args) => {
    const name = String(args[1])
    bundle(name, [{ id: name, name: './plugin.mjs', config: { service: name } }])
    const manifest = readProfileManifest('test', dir)
    manifest.dependencies = { ...manifest.dependencies, [name]: '1.0.0' }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    return { exitCode: 0, output: 'installed', truncated: false, logPath: join(dir, 'pnpm.log') }
  })
  onTestFinished(() => { install.mockRestore() })
  expect(await manager.installBundle('new-bundle', { enabled: false })).toMatchObject({ changed: true, application: 'applied', packageResult: { exitCode: 0 } })
  expect((await manager.listBundles()).find(row => row.name === 'new-bundle')?.enabled).toBe(false)
  expect(await manager.setBundleEnabled('new-bundle', true)).toMatchObject({ application: 'applied' })
  expect((await manager.listPlugins()).find(row => row.patchId === 'new-bundle')?.fiberPhase).toBe('active')
  expect(await manager.installBundle('another-bundle')).toMatchObject({ application: 'applied' })
  expect((await manager.listBundles()).find(row => row.name === 'another-bundle')?.enabled).toBe(true)
})

it('unloads before removing packages and retries inactive dependencies whose files are missing', async () => {
  const { manager, dir, ctx } = await fixture()
  const remove = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async () => {
    expect([...ctx.loader.entries()].some(row => row.id === 'include:managed')).toBe(false)
    return { exitCode: 1, output: 'removal failed', truncated: false, logPath: join(dir, 'pnpm.log') }
  })
  onTestFinished(() => { remove.mockRestore() })
  expect(await manager.removeBundle('extra')).toMatchObject({ changed: true, application: 'failed', packageResult: { exitCode: 1 } })
  expect(readProfileManifest('test', dir).dependencies).toEqual({ extra: '1.0.0' })
  expect((await manager.listBundles()).find(row => row.name === 'extra')?.enabled).toBe(false)
  rmSync(join(dir, 'node_modules', 'extra'), { recursive: true })
  remove.mockImplementationOnce(async () => {
    const manifest = readProfileManifest('test', dir)
    delete manifest.dependencies?.extra
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    return { exitCode: 0, output: 'removed', truncated: false, logPath: join(dir, 'pnpm.log') }
  })
  expect(await manager.removeBundle('extra')).toMatchObject({ changed: true, application: 'applied' })
  expect((await manager.listBundles()).some(row => row.name === 'extra')).toBe(false)
})

it('restores the manifest and lockfile after a failed package run, classifying the failure', async () => {
  const { manager, dir } = await fixture()
  const lockPath = join(dir, 'pnpm-lock.yaml')
  const install = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async () => {
    const manifest = readProfileManifest('test', dir)
    manifest.dependencies = { ...manifest.dependencies, partial: '1' }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    writeFileSync(lockPath, 'partial lockfile\n')
    return { exitCode: 42, output: 'ERR_PNPM_META_FETCH_FAIL  GET https://registry/partial: ENOTFOUND', truncated: false, logPath: join(dir, 'pnpm.log') }
  })
  onTestFinished(() => { install.mockRestore() })
  const before = readFileSync(join(dir, 'package.json'), 'utf8')
  expect(await manager.installBundle('partial')).toMatchObject({ changed: false, application: 'failed', packageResult: { exitCode: 42, kind: 'network' } })
  expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before)
  // A lockfile the run created is removed; one that existed is put back.
  expect(existsSync(lockPath)).toBe(false)
  writeFileSync(lockPath, 'original lockfile\n')
  expect(await manager.installBundle('partial')).toMatchObject({ changed: false, application: 'failed' })
  expect(readFileSync(lockPath, 'utf8')).toBe('original lockfile\n')
  expect((await manager.listBundles()).some(row => row.name === 'partial')).toBe(false)
})

it('keeps saved changes after activation failure and allows a corrected configuration to retry', async () => {
  const { manager, dir } = await fixture()
  writeFileSync(join(dir, 'cordis.patch.yml'), '- id: managed\n  disabled: true\n  config: { fail: true }\n')
  const id = (await manager.listPlugins()).find(row => row.patchId === 'managed')!.entryId
  expect(await manager.setPluginEnabled(id, true)).toMatchObject({ changed: true, application: 'failed' })
  expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toContain('disabled: false')
  writeFileSync(join(dir, 'cordis.patch.yml'), '- id: managed\n  disabled: true\n  config: { fail: false }\n')
  expect(await manager.setPluginEnabled(id, true)).toMatchObject({ application: 'applied' })
})


it('combines concurrent changes into durable notices without waking Agents', async () => {
  const session = Session.create(SessionId('manager-notices'))
  const wake = vi.fn()
  const notices: UserMessage[] = []
  const liveAgents = [{
    inject(message: UserMessage) {
      notices.push(message)
      session.append('user/message', message, { surfaceOp: 'append' })
    }, followup: wake, steer: wake,
  }, { inject() { throw new Error('already disposed') } }]
  const agents = { list: () => liveAgents }
  const { manager } = await fixture('live', false, (ctx) => { ctx.provide('agents', agents as unknown as AgentRegistry) })
  const id = (await manager.listPlugins()).find(row => row.patchId === 'managed')!.entryId
  await Promise.all([manager.setPluginEnabled(id, false), manager.setPluginEnabled(id, true)])
  expect(notices).toHaveLength(1)
  expect(JSON.stringify(notices)).toContain('disabled')
  expect(JSON.stringify(notices)).toContain('enabled')
  expect(wake).not.toHaveBeenCalled()
  expect(session.snapshotEvents().filter(row => row.type === 'user/message')).toHaveLength(1)
})


it('reports plain dependencies, missing versions and invalid selected bundles distinctly', async () => {
  const { manager, dir, profile } = await fixture()
  writeFileSync(profile.installAnchor, '{}')
  writeFileSync(join(dir, 'node_modules', 'extra', 'package.json'), '{"name":"extra"}')
  expect((await manager.listBundles()).find(row => row.name === 'extra')).toMatchObject({ enabled: true, error: 'Not a bundle: extra' })
  expect(await manager.setBundleEnabled('extra', false)).toMatchObject({ application: 'applied' })
  expect((await manager.listBundles()).some(row => row.name === 'extra')).toBe(false)
  expect(await manager.setBundleEnabled('extra', true)).toMatchObject({ changed: false, application: 'failed' })
  writeFileSync(join(dir, 'node_modules', 'core', 'package.json'), '{"name":"core","dsh":{"bundle":{"patch":"./cordis.patch.yml"}}}')
  expect((await manager.listBundles())[0]?.version).toBeUndefined()
  writeFileSync(join(dir, 'package.json'), '{}')
  expect(await manager.listBundles()).toEqual([])
  expect(await manager.setBundleEnabled('unknown', false)).toMatchObject({ application: 'failed' })
  writeFileSync(profile.installAnchor, '{"dependencies":{"missing-builtin":"1"}}')
  expect(await manager.listBundles()).toEqual([])
})

it('refuses management bundle disablement and permits repeated bundle selections', async () => {
  const { manager } = await fixture()
  expect(await manager.setBundleEnabled('core', false)).toMatchObject({ application: 'failed', changed: false })
  expect(await manager.setBundleEnabled('extra', true)).toMatchObject({ application: 'applied', changed: false })
})

it('addresses children inside profile groups and marks ambiguous ids read-only', async () => {
  const { manager, bundle, profile } = await fixture('live', false, (ctx) => { ctx.loader.builtins.group = Group })
  bundle('grouped', [{ id: 'group', name: 'cordis:group', group: true,
    config: [{ id: 'child', name: './plugin.mjs', config: { service: 'child' } }] }])
  expect(await manager.setBundleEnabled('grouped', true)).toMatchObject({ application: 'applied' })
  expect((await manager.listPlugins()).find(row => row.patchId === 'child')).toBeDefined()
  const entries = composeEntries([readProfilePatches('test', profile)])
  const duplicate = entries.find(row => row.id === 'managed')!
  writeFileSync(profile.patchPath, JSON.stringify([{ insert: [duplicate] }]))
  expect((await manager.listPlugins()).find(row => row.entryId === 'include:managed')?.readOnlyReason).toContain('not uniquely addressable')
})

it.each(['', '-g'])('rejects an invalid installation spec before calling pnpm: %j', async (spec) => {
  const { manager } = await fixture()
  expect(await manager.installBundle(spec)).toMatchObject({ changed: false, application: 'failed' })
})

it('restores the manifest when the package pnpm added declares no bundle', async () => {
  const { manager, dir, bundle } = await fixture()
  const install = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async () => {
    bundle('plain', [])
    writeFileSync(join(dir, 'node_modules', 'plain', 'package.json'), '{"name":"plain"}')
    const manifest = readProfileManifest('test', dir)
    manifest.dependencies = { ...manifest.dependencies, plain: '1' }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    return { exitCode: 0, output: 'installed', truncated: false, logPath: join(dir, 'pnpm.log') }
  })
  onTestFinished(() => { install.mockRestore() })
  expect(await manager.installBundle('plain')).toMatchObject({ changed: false, application: 'failed', message: 'plain declares no dsh.bundle.patch', packageResult: { exitCode: 0 } })
  expect(readProfileManifest('test', dir)).toMatchObject({ dependencies: { extra: '1.0.0' }, dsh: { profile: { bundles: ['core', 'extra'] } } })
})

it('reports repeated installs as requiring restart and ambiguous package changes as failures', async () => {
  const { manager, dir } = await fixture()
  const install = vi.spyOn(operations, 'runProfilePnpm').mockResolvedValue({ exitCode: 0, output: '', truncated: false, logPath: join(dir, 'pnpm.log') })
  onTestFinished(() => { install.mockRestore() })
  expect(await manager.installBundle('extra')).toMatchObject({ changed: false, application: 'restart-required' })
  expect(await manager.installBundle('extra@1')).toMatchObject({ changed: false, application: 'restart-required' })
  expect(await manager.installBundle('extra-long@1')).toMatchObject({ changed: false, application: 'failed' })
  install.mockImplementationOnce(async () => {
    writeFileSync(join(dir, 'package.json'), '{}')
    return { exitCode: 0, output: '', truncated: false, logPath: join(dir, 'pnpm.log') }
  })
  expect(await manager.installBundle('unknown')).toMatchObject({ changed: false, application: 'failed', message: 'Cannot identify one installed bundle from the dependency change' })
  expect(readProfileManifest('test', dir).dependencies).toEqual({ extra: '1.0.0' })
})

it('streams pnpm output, reports the installation phases, and names the installed bundle', async () => {
  const { ctx, manager, dir, bundle } = await fixture()
  const chunks: PluginInstallLogChunk[] = []
  const phases: PluginInstallProgress[] = []
  const changes: PluginChange[] = []
  ctx.on('plugin-manager/install-log', (chunk) => { chunks.push(chunk) })
  ctx.on('plugin-manager/install-state', (progress) => { phases.push(progress) })
  ctx.on('plugin-manager/changed', (change) => { changes.push(change) })
  const install = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async (_context, args, options) => {
    options.onOutput?.('Progress: resolved 1\n', 'stdout')
    options.onOutput?.('warning\n', 'stderr')
    const name = String(args[1])
    bundle(name, [{ id: name, name: './plugin.mjs', config: { service: name } }])
    const manifest = readProfileManifest('test', dir)
    manifest.dependencies = { ...manifest.dependencies, [name]: '1.0.0' }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    return { exitCode: 0, output: 'installed', truncated: false, logPath: join(dir, 'pnpm.log') }
  })
  onTestFinished(() => { install.mockRestore() })
  const requestId = 'f2340b6d-40bb-46b7-8b94-217bdf5010bd' as PluginInstallRequestId
  expect(await manager.installBundle('streamed', { enabled: false, requestId })).toMatchObject({ application: 'applied', changed: true, bundle: 'streamed' })
  expect(install).toHaveBeenCalledWith(expect.objectContaining({ profile: 'test' }), ['add', 'streamed'], expect.objectContaining({ command: 'pnpm' }))
  const jobId = chunks[0]?.jobId
  expect(chunks).toEqual([
    { requestId, jobId, argv: ['pnpm', 'add', 'streamed'], cwd: dir, stream: 'stdout', text: 'Progress: resolved 1\n' },
    { requestId, jobId, argv: ['pnpm', 'add', 'streamed'], cwd: dir, stream: 'stderr', text: 'warning\n' },
    { requestId, jobId, argv: ['pnpm', 'add', 'streamed'], cwd: dir, stream: 'stdout', text: '', exitCode: 0 },
  ])
  expect(phases).toEqual([{ requestId, phase: 'installing' }, { requestId, phase: 'applying' }])
  expect(changes).toEqual([{ reason: 'install' }])
  // A run without a request id streams too, unidentified.
  await manager.removeBundle('streamed')
  expect(chunks.at(-1)).toMatchObject({ argv: ['pnpm', 'remove', 'streamed'], stream: 'stdout', exitCode: 0 })
  expect(chunks.at(-1)).not.toHaveProperty('requestId')
})

it('stops a run on request, restores the files, and answers not-running or too-late otherwise', async () => {
  const { ctx, manager, dir, bundle } = await fixture()
  const phases: PluginInstallProgress[] = []
  ctx.on('plugin-manager/install-state', (progress) => { phases.push(progress) })
  const started = Promise.withResolvers<undefined>()
  const install = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async (_context, _args, options) => {
    const manifest = readProfileManifest('test', dir)
    manifest.dependencies = { ...manifest.dependencies, slow: '1' }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    started.resolve(undefined)
    await new Promise<undefined>((resolve) => { options.signal?.addEventListener('abort', () => { resolve(undefined) }, { once: true }) })
    return { exitCode: 1, output: 'killed', truncated: false, logPath: join(dir, 'pnpm.log') }
  })
  onTestFinished(() => { install.mockRestore() })
  const requestId = 'f2340b6d-40bb-46b7-8b94-217bdf5010bd' as PluginInstallRequestId
  const before = readFileSync(join(dir, 'package.json'), 'utf8')
  const run = manager.installBundle('slow', { requestId })
  await started.promise
  expect(await manager.cancelInstall('00000000-0000-4000-8000-000000000000' as PluginInstallRequestId)).toEqual({ status: 'not-running' })
  expect(await manager.cancelInstall(requestId)).toEqual({ status: 'cancelled' })
  expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before)
  expect(await run).toMatchObject({ application: 'cancelled', changed: false, message: 'Installation cancelled', packageResult: { exitCode: 1 } })
  expect(phases).toEqual([{ requestId, phase: 'installing' }, { requestId, phase: 'cancelling' }])
  expect(await manager.cancelInstall(requestId)).toEqual({ status: 'not-running' })
  // Once pnpm has exited and the bundle is being applied, the run cannot be stopped.
  install.mockImplementation(async (_context, args) => {
    const name = String(args[1])
    bundle(name, [{ id: name, name: './plugin.mjs', config: { service: name } }])
    const manifest = readProfileManifest('test', dir)
    manifest.dependencies = { ...manifest.dependencies, [name]: '1.0.0' }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    return { exitCode: 0, output: 'installed', truncated: false, logPath: join(dir, 'pnpm.log') }
  })
  let tooLate: Promise<unknown> | undefined
  ctx.on('plugin-manager/install-state', (progress) => { if (progress.phase === 'applying') tooLate = manager.cancelInstall(progress.requestId) })
  expect(await manager.installBundle('late', { requestId })).toMatchObject({ application: 'applied', bundle: 'late' })
  expect(await tooLate).toEqual({ status: 'too-late' })
  // A request aborted before its turn under the lock never starts pnpm.
  const early = manager.installBundle('never', { requestId })
  const queued = manager.installBundle('after', { requestId: '11111111-1111-4111-8111-111111111111' as PluginInstallRequestId })
  expect(await manager.cancelInstall('11111111-1111-4111-8111-111111111111' as PluginInstallRequestId)).toEqual({ status: 'cancelled' })
  await early
  expect(await queued).toMatchObject({ application: 'cancelled', changed: false })
})

it('reads what a spec names before installing it', async () => {
  const { manager, dir, profile } = await fixture(undefined, false, undefined, { inspectTimeoutMs: 1000, pnpmCommand: 'pnpm-test' })
  const view = vi.spyOn(operations, 'viewProfilePackage')
  onTestFinished(() => { view.mockRestore() })
  const answers = (stdout: string) => view.mockResolvedValueOnce({ exitCode: 0, stdout, stderr: '', timedOut: false })
  answers(JSON.stringify({ name: 'dsh-x', version: '1.4.2', description: 'A sidebar.', dsh: { title: 'Sidebar', bundle: { patch: './cordis.patch.yml' } } }))
  expect(await manager.inspect('dsh-x')).toEqual({
    status: 'accepted', kind: 'registry', name: 'dsh-x', version: '1.4.2', description: 'A sidebar.', title: 'Sidebar', bundle: true,
  })
  expect(view).toHaveBeenCalledWith(dir, 'dsh-x', { command: 'pnpm-test', timeoutMs: 1000 })
  const signal = AbortSignal.abort()
  answers(JSON.stringify([{ name: 'dsh-lib', version: '1.0.0', dsh: { bundle: {} } }, { name: 'dsh-lib', version: '1.1.0', dsh: null }]))
  expect(await manager.inspect('dsh-lib@^1', signal)).toEqual({ status: 'refused', problem: 'not-a-bundle', reason: 'dsh-lib declares no dsh.bundle' })
  expect(view).toHaveBeenLastCalledWith(dir, 'dsh-lib@^1', { command: 'pnpm-test', timeoutMs: 1000, signal })
  // An answer that names no package keeps the name the spec gave; colour escapes around the JSON are dropped.
  answers('\x1b[36m' + JSON.stringify({ version: '0.0.1', description: '', dsh: { bundle: { patch: './p.yml' } } }) + '\x1b[39m\n')
  expect(await manager.inspect('dsh-bare')).toEqual({ status: 'accepted', kind: 'registry', name: 'dsh-bare', version: '0.0.1', bundle: true })
  const failure = (stderr: string, exitCode: number | null = 1, more: Partial<operations.PackageViewResult> = {}) =>
    view.mockResolvedValueOnce({ exitCode, stdout: '', stderr, timedOut: false, ...more })
  failure('npm error code E404\nnpm error 404 Not Found - GET https://registry/nope\n')
  expect(await manager.inspect('nope')).toMatchObject({ status: 'refused', problem: 'not-found', reason: expect.stringContaining('E404') as string })
  failure('ERR_PNPM_NO_MATCHING_VERSION  No matching version found for old@9\n')
  expect(await manager.inspect('old@9')).toMatchObject({ status: 'refused', problem: 'not-found' })
  failure('ERR_PNPM_META_FETCH_FAIL  request failed, reason: getaddrinfo ENOTFOUND registry\n')
  expect(await manager.inspect('far')).toMatchObject({ status: 'refused', problem: 'network' })
  view.mockResolvedValueOnce({ exitCode: 3, stdout: 'plain text\n', stderr: '', timedOut: false })
  expect(await manager.inspect('odd')).toEqual({ status: 'refused', problem: 'unknown', reason: 'plain text' })
  failure('', 4)
  expect(await manager.inspect('quiet')).toEqual({ status: 'refused', problem: 'unknown', reason: 'pnpm view exited with 4' })
  failure('', null, { timedOut: true })
  expect(await manager.inspect('slow')).toEqual({ status: 'refused', problem: 'unknown', reason: 'pnpm view timed out after 1000ms' })
  failure('', null, { cause: Object.assign(new Error('spawn pnpm ENOENT'), { code: 'ENOENT' }) })
  expect(await manager.inspect('gone')).toMatchObject({ status: 'refused', problem: 'unknown', reason: expect.stringContaining('ENOENT') as string })
  answers('not json')
  expect(await manager.inspect('garbled')).toMatchObject({ status: 'refused', problem: 'unknown', reason: expect.stringContaining('unreadable pnpm view output') as string })
  answers('"just a string"')
  expect(await manager.inspect('scalar')).toEqual({ status: 'refused', problem: 'unknown', reason: 'pnpm view answered no package' })
  answers('')
  expect(await manager.inspect('silent')).toEqual({ status: 'refused', problem: 'unknown', reason: 'pnpm view answered no package' })
  // What is installed, or supplied by the installation, is refused before the registry is asked.
  expect(await manager.inspect('extra')).toEqual({ status: 'refused', problem: 'already-installed', reason: 'extra is already installed' })
  expect(await manager.inspect('./relative')).toEqual({ status: 'refused', problem: 'invalid-spec', reason: 'a local path must be absolute' })
  expect(await manager.inspect('github:acme/dsh-remote')).toEqual({ status: 'accepted', kind: 'git', bundle: null })
  const tarball = join(profile.home, 'pack.tgz')
  expect(await manager.inspect(tarball)).toEqual({ status: 'refused', problem: 'not-a-package', reason: 'the tarball does not exist' })
  writeFileSync(tarball, '')
  expect(await manager.inspect(tarball)).toEqual({ status: 'accepted', kind: 'tarball', bundle: null })
  expect(await manager.inspect('https://cdn.example.com/x/y/z/dsh-x-1.0.0.tgz')).toEqual({ status: 'accepted', kind: 'tarball', bundle: null })
  // A directory answers from its own manifest.
  const local = join(profile.home, 'dev', 'dsh-local')
  mkdirSync(local, { recursive: true })
  expect(await manager.inspect(join(profile.home, 'dev', 'missing'))).toEqual({ status: 'refused', problem: 'not-a-package', reason: 'the path does not exist' })
  expect(await manager.inspect(local)).toMatchObject({ status: 'refused', problem: 'not-a-package', reason: expect.stringContaining('no readable package.json') as string })
  writeFileSync(join(local, 'package.json'), '{"version":"1.0.0"}')
  expect(await manager.inspect(local)).toEqual({ status: 'refused', problem: 'not-a-package', reason: 'the package.json names no package' })
  writeFileSync(join(local, 'package.json'), JSON.stringify({ name: 'dsh-local', version: '0.1.0', description: 'Local.' }))
  expect(await manager.inspect(local)).toEqual({ status: 'refused', problem: 'not-a-bundle', reason: 'dsh-local declares no dsh.bundle' })
  writeFileSync(join(local, 'package.json'), JSON.stringify({ name: 'dsh-local', version: '0.1.0', description: 'Local.', dsh: { bundle: { patch: './p.yml' } } }))
  expect(await manager.inspect(`file:${local}`)).toEqual({ status: 'accepted', kind: 'path', name: 'dsh-local', version: '0.1.0', description: 'Local.', bundle: true })
  writeFileSync(join(local, 'package.json'), JSON.stringify({ name: 'core', dsh: { bundle: { patch: './p.yml' } } }))
  expect(await manager.inspect(local)).toEqual({ status: 'refused', problem: 'already-installed', reason: 'core is already installed' })
  // A profile and an installation that list nothing know nothing.
  writeFileSync(join(dir, 'package.json'), '{}')
  writeFileSync(profile.installAnchor, '{}')
  expect(await manager.inspect(local)).toEqual({ status: 'accepted', kind: 'path', name: 'core', bundle: true })
  expect(view).toHaveBeenCalledTimes(13)
})

it('announces a patch generation applied outside the manager as a change', async () => {
  const { ctx, manager, profile } = await fixture()
  const changes: PluginChange[] = []
  ctx.on('plugin-manager/changed', (change) => { changes.push(change) })
  await reconcileProfilePatches(ctx, readProfilePatches('test', profile), 'test')
  expect(changes).toEqual([{ reason: 'reload' }])
  const id = (await manager.listPlugins()).find(row => row.patchId === 'managed')!.entryId
  await manager.setPluginEnabled(id, false)
  expect(changes).toEqual([{ reason: 'reload' }, { reason: 'plugin' }])
})

it('handles missing patch files and retains non-Error package diagnostics', async () => {
  const { manager, dir } = await fixture()
  rmSync(join(dir, 'cordis.patch.yml'))
  const id = (await manager.listPlugins()).find(row => row.patchId === 'managed')!.entryId
  expect(await manager.setPluginEnabled(id, false)).toMatchObject({ changed: true, application: 'applied' })
  const install = vi.spyOn(operations, 'runProfilePnpm').mockRejectedValueOnce('pnpm rejected operation')
  onTestFinished(() => { install.mockRestore() })
  expect(await manager.installBundle('new')).toMatchObject({ changed: false, application: 'failed', message: 'pnpm rejected operation' })
  rmSync(join(dir, 'cordis.patch.yml'))
  mkdirSync(join(dir, 'cordis.patch.yml'))
  await expect(manager.setPluginEnabled(id, true)).rejects.toThrow()
})

it('bounds batched notices and discloses omitted operation results', async () => {
  const messages: UserMessage[] = []
  const { manager } = await fixture('live', false, (ctx) => {
    ctx.provide('agents', { list: () => [{ inject: (message: UserMessage) => { messages.push(message) } }] } as unknown as AgentRegistry)
  }, { outputBytes: 1, notificationDelayMs: 0 })
  await manager.setBundleEnabled('extra', false)
  expect(JSON.stringify(messages)).toContain('1 additional operations omitted')
})

it('applies a manager change through the active HMR service', async () => {
  const { ctx, manager } = await fixture()
  await ctx.plugin(Timer)
  await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
  const id = (await manager.listPlugins()).find(row => row.patchId === 'managed')!.entryId
  expect(await manager.setPluginEnabled(id, false)).toMatchObject({ changed: true, application: 'applied' })
  expect((await manager.listPlugins()).find(row => row.entryId === id)?.enabled).toBe(false)
})
