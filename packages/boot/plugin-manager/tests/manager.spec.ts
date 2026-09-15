/** Persistent manager behavior through a real profile Include and Loader. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type AgentRegistry from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { expect, it, onTestFinished, vi } from 'vitest'
import {
  boot, composeEntries, initProfile, readProfilePatches, readProfileManifest, reconcileProfilePatches,
  type ProfileContext,
} from '@deepseek-ai/dsh-app-boot'
import PluginManager, { type Config } from '../src/index.ts'
import Hmr from '@deepseek-ai/dsh-hmr'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { Group } from '@deepseek-ai/cordis-plugin-loader'
import * as operations from '../src/operations.ts'

async function fixture(reload: 'live' | 'startup' = 'live', overlay = false, prepare?: (ctx: Context) => void, config: Config = {}) {
  const home = mkdtempSync(join(tmpdir(), 'plugin-manager-'))
  const dir = join(home, 'profiles', 'test')
  const anchor = join(home, 'package.json')
  writeFileSync(anchor, '{"name":"installation","dependencies":{}}\n')
  initProfile(dir, ['core', 'extra'])
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
  const overlays: PatchOptions[] = overlay ? [{ id: 'managed', disabled: true }] : []
  const profile: ProfileContext = {
    name: 'test',
    startedBundles: ['core', 'extra'],
    dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: anchor, cwd: home, home,
    overlays, telemetryDisabledEnv: undefined,
  }
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (ctx) => {
    ctx.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    prepare?.(ctx)
    ctx.provide('profileContext', profile)
    ctx.loader.builtins.manager = PluginManager
  })
  onTestFinished(async () => { await ctx.fiber.dispose(); rmSync(home, { recursive: true, force: true }) })
  let stopHmr = async () => {}
  if (reload === 'live') {
    await ctx.plugin(Timer)
    const owner = await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
    stopHmr = () => owner.dispose()
    await ctx.hmr.runExclusive(async () => {})
  }
  return { ctx, dir, manager: ctx.pluginManager, bundle, profile, stopHmr, overlays }
}

it('lists bundle versions and current-profile plugin targets', async () => {
  const { manager } = await fixture()
  const plugins = await manager.listPlugins()
  expect(plugins.find(row => row.entryId === 'include:managed')).toMatchObject({ patchId: 'managed', enabled: true })
  expect(plugins.find(row => row.entryId === 'include:manager')?.readOnlyReason).toBeDefined()
  expect(await manager.listBundles()).toEqual([
    { name: 'core', version: '1.0.0', enabled: true, removable: false, readOnlyReason: 'management-required' },
    { name: 'extra', version: '1.0.0', enabled: true, removable: true },
  ])
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
    await ctx.hmr.runExclusive(async () => {
      expect([...ctx.loader.entries()].some(row => row.id === 'include:managed')).toBe(false)
    })
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

it('reports package failure separately from partial disk changes', async () => {
  const { manager, dir } = await fixture()
  const install = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async () => {
    const manifest = readProfileManifest('test', dir)
    manifest.dependencies = { ...manifest.dependencies, partial: '1' }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    return { exitCode: 42, output: 'fetch failed', truncated: false, logPath: join(dir, 'pnpm.log') }
  })
  onTestFinished(() => { install.mockRestore() })
  expect(await manager.installBundle('partial')).toMatchObject({ changed: true, application: 'failed', packageResult: { exitCode: 42 } })
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual(['core', 'extra'])
  expect((await manager.listBundles()).find(row => row.name === 'partial')?.error?.diagnostic).toContain('cannot resolve profile bundle')
})

it('keeps saved changes after activation failure and allows a corrected configuration to retry', async () => {
  const { manager, dir } = await fixture()
  writeFileSync(join(dir, 'cordis.patch.yml'), '- id: managed\n  disabled: true\n  config: { fail: true }\n')
  const id = (await manager.listPlugins()).find(row => row.patchId === 'managed')!.entryId
  expect(await manager.setPluginEnabled(id, true)).toMatchObject({ changed: true, application: 'failed' })
  expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toContain('disabled: false')
  writeFileSync(join(dir, 'cordis.patch.yml'), '- id: managed\n  disabled: true\n  config: { fail: false }\n')
  const result = await manager.setPluginEnabled(id, true)
  expect(result, JSON.stringify(result)).toMatchObject({ application: 'applied' })
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
  const noticeText = notices[0]?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
  expect(noticeText).toContain('"enabled":false')
  expect(noticeText).toContain('"enabled":true')
  expect(wake).not.toHaveBeenCalled()
  expect(session.snapshotEvents().filter(row => row.type === 'user/message')).toHaveLength(1)
})


it('reports plain dependencies, missing versions and invalid selected bundles distinctly', async () => {
  const { manager, dir, profile } = await fixture()
  writeFileSync(profile.installAnchor, '{}')
  writeFileSync(join(dir, 'node_modules', 'extra', 'package.json'), '{"name":"extra"}')
  expect((await manager.listBundles()).find(row => row.name === 'extra')).toMatchObject({ enabled: true, error: { code: 'not-bundle' } })
  expect(await manager.setBundleEnabled('extra', false)).toMatchObject({ application: 'applied' })
  expect((await manager.listBundles()).find(row => row.name === 'extra')).toMatchObject({ enabled: false, removable: true, error: { code: 'not-bundle' } })
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

it.each([
  '@deepseek-ai/dsh-host-plugin-inventory',
  '@deepseek-ai/dsh-typert-registry',
  '@deepseek-ai/dsh-api-remotes',
])('protects the management dependency %s and its containing bundle', async (name) => {
  const { ctx, manager, bundle, profile, dir } = await fixture('startup')
  bundle('extra', [{ id: 'dependency', name, disabled: true }])
  await reconcileProfilePatches(ctx, readProfilePatches('test', profile), 'test')
  const entry = (await manager.listPlugins()).find(row => row.moduleName === name)!
  expect(entry).toMatchObject({ readOnlyReason: 'management-required' })
  const manifest = readFileSync(join(dir, 'package.json'), 'utf8')
  const patch = readFileSync(profile.patchPath, 'utf8')
  expect(await manager.setPluginEnabled(entry.entryId, false)).toMatchObject({
    changed: false, application: 'failed', error: { code: 'management-required' },
  })
  expect((await manager.listBundles()).find(row => row.name === 'extra')).toMatchObject({
    removable: false, readOnlyReason: 'management-required',
  })
  expect(await manager.setBundleEnabled('extra', false)).toMatchObject({
    changed: false, application: 'failed', error: { code: 'management-required' },
  })
  expect(await manager.removeBundle('extra')).toMatchObject({
    changed: false, application: 'failed', error: { code: 'not-removable' },
  })
  expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(manifest)
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(patch)
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
  expect((await manager.listPlugins()).find(row => row.entryId === 'include:managed')?.readOnlyReason).toBe('unaddressable')
})

it.each(['', '-g'])('rejects an invalid installation spec before calling pnpm: %j', async (spec) => {
  const { manager } = await fixture()
  expect(await manager.installBundle(spec)).toMatchObject({ changed: false, application: 'failed' })
})

it.each([0, 1])('cleans a newly added non-bundle once and exposes leftovers when cleanup exits %i', async (cleanupExit) => {
  const { manager, dir, bundle } = await fixture()
  const install = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async (_context, args) => {
    const manifest = readProfileManifest('test', dir)
    if (args[0] === 'add') {
      bundle('plain', [])
      writeFileSync(join(dir, 'node_modules', 'plain', 'package.json'), '{"name":"plain"}')
      manifest.dependencies = { ...manifest.dependencies, plain: '1' }
    } else if (cleanupExit === 0) {
      delete manifest.dependencies?.plain
      rmSync(join(dir, 'node_modules', 'plain'), { recursive: true })
    }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    return { exitCode: args[0] === 'add' ? 0 : cleanupExit, output: 'package diagnostic', truncated: false, logPath: join(dir, `${args[0]}.log`) }
  })
  onTestFinished(() => { install.mockRestore() })
  expect(await manager.installBundle('plain')).toMatchObject({ changed: cleanupExit !== 0, application: 'failed', stage: 'install',
    error: { code: 'not-bundle' }, packageResult: { exitCode: 0 },
    cleanup: { name: 'plain', packageResult: { exitCode: cleanupExit } },
    remainingDependencies: cleanupExit === 0 ? [] : ['plain'] })
  expect(install.mock.calls.map(call => call[1])).toEqual([['add', 'plain'], ['remove', 'plain']])
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual(['core', 'extra'])
  const leftover = (await manager.listBundles()).find(row => row.name === 'plain')
  if (cleanupExit === 0) expect(leftover).toBeUndefined()
  else {
    expect(leftover).toMatchObject({ enabled: false, removable: true, error: { code: 'not-bundle' } })
    expect(await manager.removeBundle('plain')).toMatchObject({ stage: 'remove', application: 'failed' })
  }
})

it('never removes an existing dependency after installation validation fails', async () => {
  const { manager, dir } = await fixture()
  writeFileSync(join(dir, 'node_modules', 'extra', 'package.json'), '{"name":"extra"}')
  const install = vi.spyOn(operations, 'runProfilePnpm').mockResolvedValue({ exitCode: 0, output: '', truncated: false, logPath: '/operation.log' })
  onTestFinished(() => { install.mockRestore() })
  const result = await manager.installBundle('extra')
  expect(result).toMatchObject({ application: 'failed', stage: 'install', error: { code: 'not-bundle' } })
  expect(result.cleanup).toBeUndefined()
  expect(install).toHaveBeenCalledOnce()
  expect(readProfileManifest('test', dir).dependencies).toEqual({ extra: '1.0.0' })
})

it('keeps a valid installed bundle when its subsequent activation fails', async () => {
  const { manager, dir, bundle } = await fixture()
  const install = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async () => {
    bundle('broken', [{ id: 'broken', name: './plugin.mjs', config: { fail: true } }])
    const manifest = readProfileManifest('test', dir)
    manifest.dependencies = { ...manifest.dependencies, broken: '1' }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    return { exitCode: 0, output: '', truncated: false, logPath: '/operation.log' }
  })
  onTestFinished(() => { install.mockRestore() })
  const result = await manager.installBundle('broken')
  expect(result).toMatchObject({ application: 'failed', stage: 'enable', packageResult: { exitCode: 0 } })
  expect(result.cleanup).toBeUndefined()
  expect(install).toHaveBeenCalledOnce()
  expect((await manager.listBundles()).find(row => row.name === 'broken')).toMatchObject({ enabled: true, removable: true })
})

it('returns unchanged failures as warnings while toggling and removing another bundle', async () => {
  const { manager, dir, bundle, ctx } = await fixture()
  bundle('broken', [
    { id: 'broken', name: './plugin.mjs', config: { fail: true } },
    { id: 'missing', name: './missing.mjs' },
    { id: 'pending', name: './pending.mjs' },
  ])
  writeFileSync(join(dir, 'node_modules/broken/pending.mjs'), 'export const inject = ["unavailable"]; export function apply() {}')
  expect(await manager.setBundleEnabled('broken', true)).toMatchObject({ application: 'failed' })
  const brokenId = (await manager.listPlugins()).find(row => row.patchId === 'broken')!.entryId
  expect(await manager.setPluginEnabled(brokenId, true)).toMatchObject({ application: 'failed' })
  expect(await manager.setBundleEnabled('broken', true)).toMatchObject({ application: 'failed' })
  const id = (await manager.listPlugins()).find(row => row.patchId === 'managed')!.entryId
  const changed = await manager.setPluginEnabled(id, false)
  expect(changed).toMatchObject({ application: 'applied' })
  expect(changed.warnings).toHaveLength(3)
  expect(await manager.setPluginEnabled(id, true)).toMatchObject({ application: 'applied' })
  const remove = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async () => {
    expect([...ctx.loader.entries()].some(row => row.id === 'include:managed')).toBe(false)
    const manifest = readProfileManifest('test', dir)
    delete manifest.dependencies?.extra
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    return { exitCode: 0, output: '', truncated: false, logPath: '/operation.log' }
  })
  onTestFinished(() => { remove.mockRestore() })
  const removed = await manager.removeBundle('extra')
  expect(removed.application).toBe('applied')
  expect(removed.warnings).toHaveLength(3)
  expect(remove).toHaveBeenCalledOnce()
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
  expect(await manager.installBundle('unknown')).toMatchObject({ changed: true, application: 'failed' })
})

it('handles missing patch files and retains non-Error package diagnostics', async () => {
  const { manager, dir } = await fixture()
  rmSync(join(dir, 'cordis.patch.yml'))
  const id = (await manager.listPlugins()).find(row => row.patchId === 'managed')!.entryId
  expect(await manager.setPluginEnabled(id, false)).toMatchObject({ changed: true, application: 'applied' })
  const install = vi.spyOn(operations, 'runProfilePnpm').mockRejectedValueOnce('pnpm rejected operation')
  onTestFinished(() => { install.mockRestore() })
  expect(await manager.installBundle('new')).toMatchObject({ changed: false, application: 'failed', error: { code: 'operation-error', diagnostic: 'pnpm rejected operation' } })
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
  expect(messages[0]?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')).toContain('"omitted":1')
})

it('applies a manager change through the active HMR service', async () => {
  const { manager } = await fixture()
  const id = (await manager.listPlugins()).find(row => row.patchId === 'managed')!.entryId
  expect(await manager.setPluginEnabled(id, false)).toMatchObject({ changed: true, application: 'applied' })
  expect((await manager.listPlugins()).find(row => row.entryId === id)?.enabled).toBe(false)
})

it('refuses removal of a hot-installed bundle after HMR is disabled', async () => {
  const { ctx, manager, dir, bundle, stopHmr } = await fixture()
  bundle('later', [{ id: 'later', name: './plugin.mjs', config: { service: 'laterProbe' } }])
  const manifest = readProfileManifest('test', dir)
  manifest.dependencies = { ...manifest.dependencies, later: '1' }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  expect(await manager.setBundleEnabled('later', true)).toMatchObject({ application: 'applied' })
  await stopHmr()
  expect(ctx.get('hmr')).toBeUndefined()
  expect(await manager.setBundleEnabled('later', false)).toMatchObject({ application: 'restart-required' })
  expect(ctx.get('laterProbe')).toBe(true)
  expect(await manager.removeBundle('later')).toMatchObject({ changed: false, application: 'failed' })
})

it('omits installation-owned plain packages from the bundle inventory', async () => {
  const { manager, dir, profile, bundle } = await fixture()
  bundle('installation-plain', [])
  writeFileSync(join(dir, 'node_modules/installation-plain/package.json'), '{"name":"installation-plain"}')
  writeFileSync(profile.installAnchor, '{"dependencies":{"installation-plain":"1"}}')
  expect((await manager.listBundles()).some(row => row.name === 'installation-plain')).toBe(false)
})

it.each(['throw', 'remove-manifest-dependencies', 'invalid-manifest'] as const)('preserves the original installation failure when cleanup encounters %s', async (failure) => {
  const { manager, dir, profile } = await fixture()
  writeFileSync(profile.installAnchor, '{}')
  const install = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async (_context, args) => {
    if (args[0] === 'add') {
      const manifest = readProfileManifest('test', dir)
      manifest.dependencies = { ...manifest.dependencies, partial: '1' }
      writeFileSync(join(dir, 'package.json'), failure === 'invalid-manifest' ? '{' : JSON.stringify(manifest))
    } else if (failure === 'throw') throw new Error('cleanup unavailable')
    else writeFileSync(join(dir, 'package.json'), '{}')
    return { exitCode: args[0] === 'add' ? 42 : 0, output: 'fetch failed', truncated: false, logPath: '/operation.log' }
  })
  onTestFinished(() => { install.mockRestore() })
  const result = await manager.installBundle('partial')
  expect(result).toMatchObject({ application: 'failed', error: { code: 'operation-error', diagnostic: 'fetch failed' } })
  if (failure === 'throw') {
    expect(result.cleanup).toMatchObject({ name: 'partial', error: { diagnostic: 'cleanup unavailable' } })
    expect(result.remainingDependencies).toEqual(['partial'])
  } else if (failure === 'invalid-manifest') {
    expect(result.warnings?.[0]).toContain('SyntaxError')
    expect(install).toHaveBeenCalledOnce()
  } else expect(result.remainingDependencies).toEqual([])
})

it.each(['ambiguous', 'selected', 'installation-owned'] as const)('does not clean newly declared dependencies that are %s', async (reason) => {
  const { manager, dir, profile } = await fixture()
  const install = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async () => {
    const manifest = readProfileManifest('test', dir)
    manifest.dependencies = { ...manifest.dependencies, partial: '1', ...reason === 'ambiguous' ? { another: '1' } : {} }
    if (reason === 'selected') manifest.dsh!.profile!.bundles!.push('partial')
    if (reason === 'installation-owned') writeFileSync(profile.installAnchor, '{"dependencies":{"partial":"1"}}')
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    return { exitCode: 42, output: 'fetch failed', truncated: false, logPath: '/operation.log' }
  })
  onTestFinished(() => { install.mockRestore() })
  const result = await manager.installBundle('partial')
  expect(result.application).toBe('failed')
  expect(result.cleanup).toBeUndefined()
  expect(result.remainingDependencies).toContain('partial')
  expect(install).toHaveBeenCalledOnce()
})

it('does not delete a bundle retained by a higher-priority overlay', async () => {
  const { ctx, manager, overlays, dir } = await fixture()
  const entry = [...ctx.loader.entries()].find(row => row.id === 'include:managed')!
  overlays.push({ insert: [{ ...entry.options }] })
  const remove = vi.spyOn(operations, 'runProfilePnpm')
  onTestFinished(() => { remove.mockRestore() })
  expect(await manager.removeBundle('extra')).toMatchObject({ changed: true, application: 'failed', error: { code: 'bundle-in-use' } })
  expect(await manager.removeBundle('extra')).toMatchObject({ changed: false, application: 'failed', error: { code: 'bundle-in-use' } })
  expect(remove).not.toHaveBeenCalled()
  expect(readProfileManifest('test', dir).dependencies).toEqual({ extra: '1.0.0' })
  expect(ctx.get('managedProbe')).toBe(true)
})

it('applies watched configuration while pnpm installation is still running', async () => {
  const { ctx, manager, dir, profile, bundle } = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const pnpm = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async () => {
    entered.resolve(undefined)
    await release.promise
    bundle('new-bundle', [])
    const manifest = readProfileManifest('test', dir)
    manifest.dependencies = { ...manifest.dependencies, 'new-bundle': '1.0.0' }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    return { exitCode: 0, output: 'installed', truncated: false, logPath: join(dir, 'pnpm.log') }
  })
  const installing = manager.installBundle('new-bundle')
  onTestFinished(async () => { release.resolve(undefined); await installing; pnpm.mockRestore() })
  await entered.promise
  writeFileSync(profile.patchPath, '- id: managed\n  disabled: true\n')
  await vi.waitFor(() => { expect(ctx.get('managedProbe')).toBeUndefined() }, { timeout: 10000 })
  expect(pnpm).toHaveBeenCalledOnce()
  release.resolve(undefined)
  expect(await installing).toMatchObject({ application: 'applied', changed: true })
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual(['core', 'extra', 'new-bundle'])
  expect(ctx.get('managedProbe')).toBeUndefined()
})
