/**
 * The plugin manager over a real profile: a temporary harness home with one
 * profile, packages staged the way pnpm leaves them, the host tree booted
 * through `boot()` with the profile runtime the launcher provides, and a
 * fake pnpm that edits the profile the way the real one does. The manager
 * is built the way the Web host's adapter builds it, reading the runtime,
 * the agent registry off the context per call.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, type Plugin } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import {
  boot, composeProfileStack, loadOptionalPatches, loadProfile, ProfileRuntime, rootIncludeEntry,
  type ComposedStack, type Profile, readPackageMetadata,
} from '@deepseek-ai/dsh-app-boot'
import {
  PluginManager, PluginOperationError, pluginOperationFailureOf,
  type PluginInstallLogChunk, type PluginInstallRequestId, type PluginInstallProgress,
  type PluginToolingConfig, type SpawnLike,
} from '@deepseek-ai/dsh-plugin-manager'
import type {} from '@deepseek-ai/dsh-agent'

const NAME = 'dsh-test'

/** A complete tooling config: the host's schema fills these defaults at load, the type does not. */
function managerConfig(overrides: Partial<PluginToolingConfig> = {}): PluginToolingConfig {
  return { pnpmCommand: 'pnpm', installTimeoutMs: 1_000, installKillGraceMs: 50, installLogTailBytes: 16_384, ...overrides }
}

/** Test seams: the child spawner and the static metadata reader. */
interface Internals {
  spawn?: SpawnLike
  metadata?: typeof readPackageMetadata
}

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** Builtins the staged bundles name; registered on every boot. */
const good: Plugin.Function = () => {}
const throws: Plugin.Function = () => { throw new Error('boom at apply') }
let flakyCalls = 0
const flaky: Plugin.Function = () => {
  flakyCalls += 1
  if (flakyCalls === 1) throw new Error('flaky first start')
}
const provider: Plugin.Function = (ctx) => { ctx.effect(() => ctx.reflect.provide('fixtureSvc', { ready: true })) }
const lonelyProvider: Plugin.Function = (ctx) => { ctx.effect(() => ctx.reflect.provide('lonelySvc', { ready: true })) }
const consumer: Plugin.Object = { inject: ['fixtureSvc'], apply() {} }
const prepare = (ctx: Context): void => {
  ctx.loader.builtins.configured = {
    Config: { '~standard': { version: 1, vendor: 'manager-test', validate(input: unknown) {
      const config = input as { value: number }
      return config.value < 0 ? { issues: [{ message: 'negative config' }] } : { value: config }
    } } },
    apply() {},
  }
  ctx.loader.builtins.good = good
  ctx.loader.builtins.throws = throws
  ctx.loader.builtins.flaky = flaky
  ctx.loader.builtins.provider = provider
  ctx.loader.builtins['lonely-provider'] = lonelyProvider
  ctx.loader.builtins.consumer = consumer
}

interface StagedHome {
  home: string
  profileDir: string
  anchor: string
}

/** A harness home with one empty live profile and an install anchor that carries nothing. */
async function stageHome(patchReload: 'live' | 'startup' = 'live'): Promise<StagedHome> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-plugin-manager-'))
  const profileDir = join(home, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true, dependencies: {}, dsh: { profile: { bundles: [], patchReload } },
  }, null, 2))
  writeFileSync(join(profileDir, 'cordis.yml'), '[]\n')
  const anchorDir = join(home, 'anchor')
  mkdirSync(anchorDir, { recursive: true })
  const anchor = join(anchorDir, 'package.json')
  writeFileSync(anchor, JSON.stringify({ name: 'dsh-anchor', version: '0.0.0', dependencies: {} }))
  return { home, profileDir, anchor }
}

interface StagedPackage {
  /** The bundle patch text; omitted stages a bundle-less package. */
  patch?: string
  /** `index.js` text, exported as the package main. */
  main?: string
  version?: string
  files?: Record<string, string>
}

/** Stage one package under the profile's node_modules, the way pnpm leaves it. */
function stagePackage(profileDir: string, name: string, staged: StagedPackage): void {
  const dir = join(profileDir, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name,
    version: staged.version ?? '1.0.0',
    description: `staged ${name}`,
    type: 'module',
    ...staged.main === undefined ? {} : { main: 'index.js' },
    dsh: {
      title: `Title of ${name}`,
      ...staged.patch === undefined ? {} : { bundle: { patch: './cordis.patch.yml' } },
    },
  }, null, 2))
  if (staged.patch !== undefined) writeFileSync(join(dir, 'cordis.patch.yml'), staged.patch)
  if (staged.main !== undefined) writeFileSync(join(dir, 'index.js'), staged.main)
  for (const [file, text] of Object.entries(staged.files ?? {})) {
    mkdirSync(join(dir, file, '..'), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
}

/** Add a dependency to the profile manifest, as `pnpm add` does. */
function addDependency(profileDir: string, name: string, spec = '1.0.0'): void {
  const path = join(profileDir, 'package.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { dependencies: Record<string, string> }
  manifest.dependencies[name] = spec
  writeFileSync(path, JSON.stringify(manifest, null, 2))
}

function manifestOf(profileDir: string): { dependencies: Record<string, string>; dsh: { profile: { bundles: string[] } } } {
  return JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as ReturnType<typeof manifestOf>
}

/** What the fake pnpm does for one invocation. */
type PnpmBehavior = (args: readonly string[]) => { code: number | null; stdout?: string; stderr?: string; hang?: boolean; error?: unknown }

/** A fake `spawn` that runs `behavior` on the next tick and reports through a child-like emitter. */
function fakePnpm(profileDir: string, behavior: PnpmBehavior, calls: string[][] = [], gate = Promise.resolve()): SpawnLike {
  return (spec) => {
    const [, ...args] = spec.argv
    calls.push([...spec.argv])
    expect(spec.cwd).toBe(profileDir)
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const exit = Promise.withResolvers<{ exitCode: number | null; signal: NodeJS.Signals | null }>()
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null = null): void => {
      stdout.end(); stderr.end(); exit.resolve({ exitCode, signal })
    }
    const terminate = (): void => { finish(null, 'SIGTERM') }
    spec.signal?.addEventListener('abort', terminate, { once: true })
    const clean = (): void => { spec.signal?.removeEventListener('abort', terminate) }
    void exit.promise.then(clean, clean)
    void gate.then(() => {
      if (spec.signal?.aborted) { terminate(); return }
      const outcome = behavior(args)
      if (outcome.error !== undefined) {
        stdout.end(); stderr.end(); exit.reject(outcome.error)
        return
      }
      if (outcome.stdout !== undefined) stdout.write(outcome.stdout)
      if (outcome.stderr !== undefined) stderr.write(outcome.stderr)
      if (!outcome.hang) finish(outcome.code)
    })
    return {
      stdin: undefined, stdout, stderr, control: undefined, collected: {}, done: exit.promise, terminate,
      waitForExit: () => exit.promise.then(() => true, () => true),
    }
  }
}

/** The pnpm every install test shares: `add <name>` stages nothing (the test did) and records the dependency. */
function recordingPnpm(profileDir: string, calls: string[][] = []): SpawnLike {
  return fakePnpm(profileDir, (args) => {
    const [verb, target] = args
    if (verb === 'add' && target !== undefined) {
      addDependency(profileDir, target)
      return { code: 0, stdout: `+ ${target} 1.0.0\n` }
    }
    if (verb === 'remove' && target !== undefined) {
      const path = join(profileDir, 'package.json')
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as { dependencies: Record<string, string> }
      const { [target]: _removed, ...remaining } = manifest.dependencies
      writeFileSync(path, JSON.stringify({ ...manifest, dependencies: remaining }, null, 2))
      rmSync(join(profileDir, 'node_modules', target), { recursive: true, force: true })
      return { code: 0, stdout: `- ${target}\n` }
    }
    return { code: 1, stderr: 'unexpected pnpm invocation\n' }
  }, calls)
}

interface Booted {
  ctx: Context
  manager: PluginManager
  runtime: ProfileRuntime
  changes: { reason: string; packageName?: string }[]
  log: PluginInstallLogChunk[]
}

/** Boot the profile the way the launcher does, then build the manager over it. */
async function bootProfile(staged: StagedHome, internals: Internals = {}, config: Partial<PluginToolingConfig> = {}): Promise<Booted> {
  const load = (): Profile => loadProfile(NAME, 'web', staged.anchor, staged.home)
  const composeFor = (profile: Profile): ComposedStack => {
    const stack = composeProfileStack(profile.layers, [
      { label: profile.patchPath, patches: loadOptionalPatches(NAME, profile.patchPath) ?? [] },
    ])
    return { ...stack, patches: structuredClone(stack.patches) }
  }
  const profile = load()
  const ctx = await boot(NAME, join(staged.profileDir, 'cordis.yml'), composeFor(profile).patches, async (ctx) => {
    prepare(ctx)
    await ctx.plugin(ProfileRuntime, {
      profile, stack: composeFor(profile), installAnchor: staged.anchor,
      loadProfile: load, compose: composeFor, rootEntry: () => rootIncludeEntry(ctx),
    })
  })
  contexts.push(ctx)
  const changes: Booted['changes'] = []
  const log: PluginInstallLogChunk[] = []
  ctx.on('plugins/changed', (change) => { changes.push(change) })
  ctx.on('plugins/install-log', (chunk) => { log.push(chunk) })
  const host = ctx.plugin({ inject: ['loader'], apply() {} })
  await host.await()
  const manager = managerOver(host.ctx, internals, config)
  return { ctx, manager, runtime: ctx.profileRuntime, changes, log }
}

/** The manager as the Web host's adapter builds it: runtime and agent count read off the context per call. */
function managerOver(ctx: Context, internals: Internals = {}, config: Partial<PluginToolingConfig> = {}): PluginManager {
  return new PluginManager(ctx, {
    config: managerConfig(config),
    runtime: () => ctx.get('profileRuntime'),
    runningAgents: () => (ctx.get('agents')?.list() ?? []).filter(agent => agent.status === 'running').length,
    ...internals,
  })
}

const entryIds = (ctx: Context): string[] => [...ctx.loader.entries()].map(entry => entry.id)

const BUNDLE_ONE_ROW = '- insert:\n    - id: hello\n      name: cordis:good\n'

describe('PluginManager', () => {
  it('keeps an installed package with malformed metadata manageable', async () => {
    const staged = await stageHome()
    stagePackage(staged.profileDir, 'broken', {})
    addDependency(staged.profileDir, 'broken')
    const { manager } = await bootProfile(staged, { spawn: recordingPnpm(staged.profileDir) })
    writeFileSync(join(staged.profileDir, 'node_modules/broken/package.json'), '{ invalid json')
    const view = (await manager.list())[0]!
    expect(view.name).toBe('broken')
    expect(view.installed).toBe(true)
    expect(view.reason).toBeTruthy()
    await manager.uninstall('broken')
    expect(await manager.list()).toEqual([])
  })
  it('shows failed group imports while omitting healthy structural groups', async () => {
    const staged = await stageHome()
    stagePackage(staged.profileDir, 'groups', { patch: `- insert:
    - id: healthy
      name: cordis:group
      group: true
      config: []
    - id: broken-group
      name: ./missing.mjs
      group: true
      config: []
` })
    addDependency(staged.profileDir, 'groups')
    const { manager } = await bootProfile(staged)
    await manager.enable('groups')
    const view = (await manager.list())[0]!
    expect(view.status).toBe('failed')
    expect(view.rows.map(row => row.rowId)).toEqual(['broken-group'])
    expect(view.rows[0]?.phase).toBe('failed')
    expect(view.rows[0]?.failure?.stage).toBe('import')
  })

  it('shows a failed config update beside the still-active old instance and attributes overrides to their owner', async () => {
    const staged = await stageHome()
    stagePackage(staged.profileDir, 'base', {
      patch: '- insert:\n    - id: core-config\n      name: cordis:configured\n      config: { value: 1 }\n',
    })
    const manifest = manifestOf(staged.profileDir)
    manifest.dsh.profile.bundles.push('base')
    writeFileSync(join(staged.profileDir, 'package.json'), JSON.stringify(manifest))
    stagePackage(staged.profileDir, 'ext', { patch: '- insert:\n    - id: ext-ok\n      name: cordis:good\n- id: core-config\n  config: { value: -1 }\n' })
    addDependency(staged.profileDir, 'ext')
    const { ctx, manager } = await bootProfile(staged)
    const result = await manager.enable('ext')
    expect(result.issues?.[0]?.entryId).toBe('include:core-config')
    const core = ctx.loader.resolve('include:core-config')
    expect(core.fiber?.state).toBe(2)
    expect(core.fiber?.config).toEqual({ value: 1 })
    expect(core.options.config).toEqual({ value: -1 })
    const views = await manager.list()
    const ext = views.find(view => view.name === 'ext')!
    expect(ext.status).toBe('partial')
    expect(ext.issues?.[0]?.stage).toBe('update')
    expect(ext.rows.map(row => row.rowId)).toEqual(['ext-ok'])
    expect(ctx.profileRuntime.originOfEntry(core)?.packageName).toBe('base')
    expect(views.find(view => view.name === 'base')?.rows[0]).toMatchObject({ phase: 'active', failure: { stage: 'update' } })
    writeFileSync(join(staged.profileDir, 'node_modules/ext/cordis.patch.yml'), '- id: core-config\n  config: { value: -1 }\n')
    await ctx.profileRuntime.recompose({ reloadBundles: true })
    expect((await manager.list()).find(view => view.name === 'ext')?.status).toBe('failed')
    await manager.disable('ext')
    expect(core.fiber?.config).toEqual({ value: 1 })
    expect((await manager.list()).find(view => view.name === 'base')?.status).toBe('running')
  })

  it('keeps a rejected preparation out of the layer list without promising rollback of live plugin effects', async () => {
    const staged = await stageHome()
    stagePackage(staged.profileDir, 'base', { patch: BUNDLE_ONE_ROW })
    const manifest = manifestOf(staged.profileDir)
    manifest.dsh.profile.bundles.push('base')
    writeFileSync(join(staged.profileDir, 'package.json'), JSON.stringify(manifest))
    stagePackage(staged.profileDir, 'clash', { patch: BUNDLE_ONE_ROW })
    addDependency(staged.profileDir, 'clash')
    const { ctx, manager } = await bootProfile(staged)
    const changedManifest = manifestOf(staged.profileDir)
    changedManifest.dsh.profile.bundles.push('missing-base')
    writeFileSync(join(staged.profileDir, 'package.json'), JSON.stringify(changedManifest))
    await expect(manager.enable('clash')).rejects.toMatchObject({ code: 'plugins/enable-failed' })
    expect(manifestOf(staged.profileDir).dsh.profile.bundles).toEqual(['base', 'missing-base'])
    expect(ctx.loader.resolve('include:hello').fiber?.state).toBe(2)
  })

  it('installs and lists a non-bundle package without executing its main module', async () => {
    const staged = await stageHome()
    const marker = join(staged.profileDir, 'executed')
    stagePackage(staged.profileDir, 'plain', {
      main: `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'bad'); export function apply() {}`,
    })
    const { manager } = await bootProfile(staged, { spawn: recordingPnpm(staged.profileDir) })
    await manager.add('plain')
    expect((await manager.list()).find(view => view.name === 'plain')?.kind).toBe('unknown')
    expect(existsSync(marker)).toBe(false)
  })

  it('reports plugins/unavailable without a profile runtime', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Loader)
    await expect(managerOver(ctx).list()).rejects.toMatchObject({ code: 'plugins/unavailable', details: { reason: 'no profile runtime' } })
  })

  describe('list', () => {
    it('folds installed, enabled, declared and running facts into one view per package', async () => {
      const staged = await stageHome()
      stagePackage(staged.profileDir, 'ext-bundle', { patch: BUNDLE_ONE_ROW, files: { 'extra.js': 'export const name = "extra"\nexport function apply() {}\n' } })
      stagePackage(staged.profileDir, 'ext-lib', { main: 'export const x = 1\n' })
      stagePackage(staged.profileDir, 'ext-plugin', { main: 'export const name = "p"\nexport function apply() {}\n' })
      addDependency(staged.profileDir, 'ext-bundle')
      addDependency(staged.profileDir, 'ext-lib')
      addDependency(staged.profileDir, 'ext-plugin')
      const { manager } = await bootProfile(staged)

      const views = await manager.list()

      expect(views.map(view => [view.name, view.kind, view.status, view.installed, view.enabled])).toEqual([
        ['ext-bundle', 'bundle', 'disabled', true, false],
        ['ext-lib', 'unknown', 'plain', true, false],
        ['ext-plugin', 'unknown', 'plain', true, false],
      ])
      const bundle = views[0]
      expect(bundle).toMatchObject({ version: '1.0.0', title: 'Title of ext-bundle', description: 'staged ext-bundle', liveReload: true })
      // Rows come from static declarations while the bundle is not composed, under the ids the patch declares.
      expect(bundle?.rows).toEqual([{ entryId: 'hello', rowId: 'hello', moduleName: 'cordis:good', enabled: true, phase: null }])
    })

    it('reads a composed bundle\'s rows from the live tree with their failures', async () => {
      const staged = await stageHome()
      stagePackage(staged.profileDir, 'ext-mixed', { patch: '- insert:\n    - id: ok\n      name: cordis:good\n    - id: bad\n      name: cordis:throws\n' })
      addDependency(staged.profileDir, 'ext-mixed')
      const manifest = manifestOf(staged.profileDir)
      manifest.dsh.profile.bundles.push('ext-mixed')
      writeFileSync(join(staged.profileDir, 'package.json'), JSON.stringify(manifest, null, 2))
      const { manager } = await bootProfile(staged)

      const [view] = await manager.list()

      expect(view).toMatchObject({ name: 'ext-mixed', status: 'partial', enabled: true })
      expect(view?.reason).toContain('boom at apply')
      expect(view?.rows.map(row => [row.entryId, row.phase, row.failure?.stage])).toEqual([
        ['include:ok', 'active', undefined],
        ['include:bad', 'failed', 'activation'],
      ])
    })

    it('lists a bundle left out by an id conflict as failed, with the conflict as its row', async () => {
      const staged = await stageHome()
      stagePackage(staged.profileDir, 'ext-one', { patch: BUNDLE_ONE_ROW })
      addDependency(staged.profileDir, 'ext-one')
      stagePackage(staged.profileDir, 'ext-two', { patch: BUNDLE_ONE_ROW })
      addDependency(staged.profileDir, 'ext-two')
      const manifest = manifestOf(staged.profileDir)
      manifest.dsh.profile.bundles.push('ext-one', 'ext-two')
      writeFileSync(join(staged.profileDir, 'package.json'), JSON.stringify(manifest, null, 2))
      const { ctx, manager } = await bootProfile(staged)

      const views = await manager.list()

      expect(entryIds(ctx)).toContain('include:hello')
      expect(views.find(view => view.name === 'ext-one')).toMatchObject({ status: 'running' })
      const two = views.find(view => view.name === 'ext-two')
      expect(two).toMatchObject({ status: 'failed', enabled: true })
      expect(two?.reason).toContain('already declared by ext-one')
      expect(two?.rows).toEqual([{
        entryId: 'conflict:ext-two:hello', rowId: 'hello', moduleName: 'cordis:good', enabled: true, phase: 'failed',
        failure: { stage: 'conflict', message: 'row "hello" is already declared by ext-one' },
      }])
    })

    it('does not import a disabled bundle and reports a stale layer as restart-required', async () => {
      const staged = await stageHome('startup')
      stagePackage(staged.profileDir, 'ext-broken', { patch: BUNDLE_ONE_ROW, main: 'throw new Error("no import for you")\n' })
      addDependency(staged.profileDir, 'ext-broken')
      stagePackage(staged.profileDir, 'ext-later', { patch: BUNDLE_ONE_ROW })
      addDependency(staged.profileDir, 'ext-later')
      const { manager } = await bootProfile(staged)
      // Enabled after boot on a startup-reload profile: the manifest says yes, the tree says no.
      const manifest = manifestOf(staged.profileDir)
      manifest.dsh.profile.bundles.push('ext-later')
      writeFileSync(join(staged.profileDir, 'package.json'), JSON.stringify(manifest, null, 2))

      const views = await manager.list()

      expect(views.find(view => view.name === 'ext-broken')).toMatchObject({ status: 'disabled' })
      expect(views.find(view => view.name === 'ext-later')).toMatchObject({ status: 'restart-required', liveReload: false })
    })

    it('reports unapplied live selections as failures instead of requiring a restart', async () => {
      const staged = await stageHome()
      stagePackage(staged.profileDir, 'ext-live', { patch: BUNDLE_ONE_ROW })
      addDependency(staged.profileDir, 'ext-live')
      const initial = manifestOf(staged.profileDir)
      initial.dsh.profile.bundles = ['ext-live']
      writeFileSync(join(staged.profileDir, 'package.json'), JSON.stringify(initial))
      const { ctx, manager } = await bootProfile(staged)
      try {
        initial.dsh.profile.bundles = []
        writeFileSync(join(staged.profileDir, 'package.json'), JSON.stringify(initial))
        const [view] = await manager.list()
        expect(view).toMatchObject({ enabled: false, liveReload: true, status: 'failed', reason: expect.stringContaining('not been applied') as string })
        expect(view?.rows[0]?.phase).toBe('active')
      } finally {
        await ctx.fiber.dispose()
        rmSync(staged.home, { recursive: true, force: true })
      }
    })

    it('reports unreadable declarations and treats physical peer identity as advisory', async () => {
      const staged = await stageHome()
      stagePackage(staged.profileDir, 'ext-odd', { patch: BUNDLE_ONE_ROW })
      addDependency(staged.profileDir, 'ext-odd')
      stagePackage(staged.profileDir, 'ext-refused', { patch: BUNDLE_ONE_ROW })
      addDependency(staged.profileDir, 'ext-refused')
      const { manager } = await bootProfile(staged, {
        metadata: ({ packageName }) => {
          if (packageName === 'ext-odd') throw new Error('invalid declarations')
          return { packageName, kind: 'bundle', cordisSameCopy: false, rows: [], overrides: [] }
        },
      })

      const views = await manager.list()

      expect(views.find(view => view.name === 'ext-odd')).toMatchObject({ status: 'not-enableable', reason: 'invalid declarations', cordisSameCopy: null, rows: [] })
      expect(views.find(view => view.name === 'ext-refused')).toMatchObject({ status: 'disabled', cordisSameCopy: false })
      await expect(manager.enable('ext-odd')).rejects.toMatchObject({ code: 'plugins/not-enableable', details: { reason: 'cannot read package declarations: invalid declarations' } })
      await expect(manager.enable('ext-refused')).resolves.toMatchObject({ effect: 'live' })
    })

    it('reads a hand-written manifest: no dependencies, a template bundle, a ghost, and a builtin layer added after boot', async () => {
      const staged = await stageHome('startup')
      stagePackage(staged.profileDir, 'tpl', { patch: BUNDLE_ONE_ROW })
      writeFileSync(join(staged.profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: ['tpl'], patchReload: 'startup' } } }))
      const { manager } = await bootProfile(staged)
      expect((await manager.list()).map(view => [view.name, view.status, view.installed, view.rows.length])).toEqual([['tpl', 'running', false, 1]])
      // A manifest with no dsh section at all knows no bundles.
      writeFileSync(join(staged.profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web' }))
      expect(await manager.list()).toEqual([])

      // Bundles the manifest names after boot: one staged, one that resolves to nothing.
      stagePackage(staged.profileDir, 'tpl-later', { patch: BUNDLE_ONE_ROW })
      writeFileSync(join(staged.profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: ['tpl', 'tpl-later', 'ghost'], patchReload: 'startup' } } }))
      const views = await manager.list()
      expect(views.map(view => [view.name, view.kind, view.status])).toEqual([
        ['tpl', 'bundle', 'running'],
        ['tpl-later', 'bundle', 'restart-required'],
        ['ghost', 'unknown', 'plain'],
      ])
      await expect(manager.uninstall('ghost')).rejects.toMatchObject({ code: 'plugins/not-installed' })
      // Retrying takes the bundle out first, which a template bundle refuses.
      await expect(manager.retry('ghost')).rejects.toMatchObject({ code: 'plugins/bad-request' })
    })

    it('folds disabled, user-disabled, and waiting rows', async () => {
      const staged = await stageHome()
      stagePackage(staged.profileDir, 'ext-off', { patch: '- insert:\n    - id: a\n      name: cordis:good\n      disabled: true\n    - id: b\n      name: cordis:good\n' })
      addDependency(staged.profileDir, 'ext-off')
      stagePackage(staged.profileDir, 'ext-waiting', { patch: '- insert:\n    - id: w\n      name: cordis:consumer\n' })
      addDependency(staged.profileDir, 'ext-waiting')
      const { manager } = await bootProfile(staged)
      await manager.enable('ext-off')
      await manager.enable('ext-waiting')
      await manager.setRowDisabled('b', true)

      const views = await manager.list()

      const off = views.find(view => view.name === 'ext-off')
      expect(off).toMatchObject({ status: 'running' })
      expect(off?.rows.map(row => [row.rowId, row.enabled, row.disabledBy, row.phase])).toEqual([
        ['a', false, 'composition', null],
        ['b', false, 'user', null],
      ])
      await manager.setRowDisabled('b', true)
      const waiting = views.find(view => view.name === 'ext-waiting')
      expect(waiting).toMatchObject({ status: 'failed', reason: expect.stringContaining('fixtureSvc') as string })
      expect(waiting?.rows).toEqual([expect.objectContaining({ entryId: 'include:w', phase: 'pending', failure: expect.objectContaining({ stage: 'inject-pending' }) as object })])
      // Another bundle's recorded failure is not this one's row.
      expect(off?.rows.some(row => row.failure !== undefined)).toBe(false)
    })

    it('reads anonymous and gated static patch rows', async () => {
      const staged = await stageHome()
      stagePackage(staged.profileDir, 'ext-anon', { patch: '- insert:\n    - name: cordis:good\n    - id: gated\n      name: cordis:good\n      disabled: true\n' })
      addDependency(staged.profileDir, 'ext-anon')
      stagePackage(staged.profileDir, 'installed-bundle', { patch: BUNDLE_ONE_ROW })
      addDependency(staged.profileDir, 'installed-bundle')
      const { manager } = await bootProfile(staged)

      const views = await manager.list()

      expect(views.find(view => view.name === 'ext-anon')?.rows).toEqual([
        { entryId: 'cordis:good', rowId: 'cordis:good', moduleName: 'cordis:good', enabled: true, phase: null },
        { entryId: 'gated', rowId: 'gated', moduleName: 'cordis:good', enabled: false, disabledBy: 'composition', phase: null },
      ])
      await manager.enable('installed-bundle')
      const installed = (await manager.list()).find(view => view.name === 'installed-bundle')
      expect(installed).toMatchObject({ status: 'running' })
      expect(installed?.rows.map(row => row.entryId)).toEqual(['include:hello'])
      await manager.disable('installed-bundle')
      expect((await manager.list()).find(view => view.name === 'installed-bundle')?.rows.map(row => row.entryId)).toEqual(['hello'])
    })
  })

  describe('add', () => {
    it('removes a package that is neither a bundle nor a plugin module and says why', async () => {
      const staged = await stageHome()
      stagePackage(staged.profileDir, 'ext-lib', { main: 'export const answer = 42\n' })
      const calls: string[][] = []
      const { manager } = await bootProfile(staged, { spawn: recordingPnpm(staged.profileDir, calls) })

      const result = await manager.add('ext-lib')

      expect(result).toMatchObject({
        installed: ['ext-lib'], plain: ['ext-lib'], installedOnly: [], removed: [],
      })
      expect(calls).toEqual([['pnpm', 'add', 'ext-lib']])
      expect(manifestOf(staged.profileDir).dependencies).toHaveProperty('ext-lib')
      expect((await manager.list()).some(view => view.name === 'ext-lib')).toBe(true)
    })

    it('removes an installed bundle whose row id another layer already owns', async () => {
      const staged = await stageHome()
      stagePackage(staged.profileDir, 'ext-one', { patch: BUNDLE_ONE_ROW })
      addDependency(staged.profileDir, 'ext-one')
      const manifest = manifestOf(staged.profileDir)
      manifest.dsh.profile.bundles.push('ext-one')
      writeFileSync(join(staged.profileDir, 'package.json'), JSON.stringify(manifest, null, 2))
      stagePackage(staged.profileDir, 'ext-two', { patch: BUNDLE_ONE_ROW })
      const calls: string[][] = []
      const { manager } = await bootProfile(staged, { spawn: recordingPnpm(staged.profileDir, calls) })

      const result = await manager.add('ext-two', { enable: true })

      expect(result).toMatchObject({
        installed: [], enabled: [], installedOnly: [],
        removed: [{ name: 'ext-two', reason: 'row "hello" is already declared by ext-one' }],
      })
      expect(calls).toEqual([['pnpm', 'add', 'ext-two'], ['pnpm', 'remove', 'ext-two']])
      expect(manifestOf(staged.profileDir)).toMatchObject({ dsh: { profile: { bundles: expect.not.arrayContaining(['ext-two']) as string[] } } })
      expect(manifestOf(staged.profileDir).dependencies).not.toHaveProperty('ext-two')
    })

    it('reports a bundle whose patch disappears after metadata discovery', async () => {
      const staged = await stageHome()
      stagePackage(staged.profileDir, 'ext-new', { patch: BUNDLE_ONE_ROW })
      const calls: string[][] = []
      const { manager } = await bootProfile(staged, {
        spawn: recordingPnpm(staged.profileDir, calls),
        metadata: (options) => {
          const metadata = readPackageMetadata(options)
          rmSync(join(staged.profileDir, 'node_modules/ext-new/cordis.patch.yml'))
          return metadata
        },
      })

      const result = await manager.add('ext-new')

      expect(result.removed).toEqual([{ name: 'ext-new', reason: expect.stringContaining('cordis.patch.yml') as string }])
      expect(calls).toEqual([['pnpm', 'add', 'ext-new'], ['pnpm', 'remove', 'ext-new']])
    })

    it('keeps an unexecuted package installed with its bundle disabled', async () => {
      const staged = await stageHome()
      stagePackage(staged.profileDir, 'ext-broken', { patch: BUNDLE_ONE_ROW, main: 'throw new Error("no import for you")\n' })
      const { manager } = await bootProfile(staged, { spawn: recordingPnpm(staged.profileDir) })

      const result = await manager.add('ext-broken')

      expect(result).toMatchObject({ installed: ['ext-broken'], removed: [] })
      expect((await manager.list()).find(view => view.name === 'ext-broken')).toMatchObject({ status: 'disabled' })
    })

    it('restores the manifest when pnpm fails after writing it', async () => {
      const staged = await stageHome()
      const manifestPath = join(staged.profileDir, 'package.json')
      const before = readFileSync(manifestPath, 'utf8')
      const { manager } = await bootProfile(staged, { spawn: fakePnpm(staged.profileDir, (args) => {
        addDependency(staged.profileDir, args[1] ?? 'ext-ghost')
        return { code: 1, stderr: 'ERR_PNPM_FETCH_404\n' }
      }) })

      await expect(manager.add('ext-ghost')).rejects.toMatchObject({ code: 'plugins/install-failed' })

      expect(readFileSync(manifestPath, 'utf8')).toBe(before)
    })

    it.each([undefined, 'original lockfile\n'])('cancels a silent install, waits for its process range and restores lockfile %s', async (lockfile) => {
      const staged = await stageHome()
      const requestId = 'f2340b6d-40bb-46b7-8b94-217bdf5010bd' as PluginInstallRequestId
      const manifestPath = join(staged.profileDir, 'package.json')
      const lockPath = join(staged.profileDir, 'pnpm-lock.yaml')
      const manifest = readFileSync(manifestPath, 'utf8')
      if (lockfile !== undefined) writeFileSync(lockPath, lockfile)
      const started = Promise.withResolvers<undefined>()
      const gone = Promise.withResolvers<undefined>()
      const pnpm = fakePnpm(staged.profileDir, () => {
        addDependency(staged.profileDir, 'partial')
        writeFileSync(lockPath, 'partially written lockfile')
        started.resolve(undefined)
        return { code: null, hang: true }
      })
      const { ctx, manager, log } = await bootProfile(staged, {
        spawn: spec => ({ ...pnpm(spec), waitForExit: () => gone.promise.then(() => true) }),
      })
      const states: PluginInstallProgress[] = []
      ctx.on('plugins/install-state', (progress) => { states.push(progress) })
      const answer = manager.add('partial', { enable: true, requestId }).catch((error: unknown) => error)
      await started.promise
      expect(states).toEqual([{ requestId, phase: 'installing' }])
      expect(log).toEqual([])
      expect(await manager.cancelInstall('other' as PluginInstallRequestId)).toEqual({ status: 'not-running' })
      const cancel = manager.cancelInstall(requestId)
      const repeated = manager.cancelInstall(requestId)
      try {
        expect(states.at(-1)).toEqual({ requestId, phase: 'cancelling' })
        await expect(manager.add('another')).rejects.toMatchObject({ code: 'plugins/busy' })
        expect(readFileSync(lockPath, 'utf8')).toBe('partially written lockfile')
      } finally { gone.resolve(undefined) }
      expect(await cancel).toEqual({ status: 'cancelled' })
      expect(await repeated).toEqual({ status: 'cancelled' })
      expect(await answer).toMatchObject({ code: 'plugins/install-cancelled', details: { requestId } })
      expect(readFileSync(manifestPath, 'utf8')).toBe(manifest)
      expect(existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : undefined).toBe(lockfile)
      expect(states.some(state => state.phase === 'applying')).toBe(false)
      expect(log.every(chunk => chunk.requestId === requestId)).toBe(true)
      expect(await manager.cancelInstall(requestId)).toEqual({ status: 'not-running' })
      await expect(manager.add('')).rejects.toMatchObject({ code: 'plugins/bad-request' })
    })

    it.skipIf(process.platform === 'win32')('terminates a real process group even when its parent exits zero and its child ignores TERM', async () => {
      // POSIX process groups and SIGTERM are the behavior under test; Windows owns taskkill semantics.
      const staged = await stageHome()
      const requestId = 'f2340b6d-40bb-46b7-8b94-217bdf5010bd' as PluginInstallRequestId
      const script = join(staged.profileDir, 'add')
      writeFileSync(script, `
        import { spawn } from 'node:child_process';
        import { writeFileSync } from 'node:fs';
        const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); console.log(String(process.pid)); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'inherit'] });
        child.stdout.once('data', bytes => {
          writeFileSync('pnpm-lock.yaml', 'partial');
          console.log(String(bytes).trim());
        });
        process.on('SIGTERM', () => process.exit(0));
        setInterval(() => {}, 1000);
      `)
      const ready = Promise.withResolvers<number>()
      const { ctx, manager } = await bootProfile(staged, {}, {
        pnpmCommand: process.execPath, installTimeoutMs: 30_000, installKillGraceMs: 50,
      })
      ctx.on('plugins/install-log', (chunk) => {
        if (chunk.stream === 'stdout' && chunk.text.trim()) ready.resolve(Number(chunk.text.trim()))
      })
      const result = manager.add('slow', { requestId, enable: true }).catch((error: unknown) => error)
      try {
        const pid = await ready.promise
        expect(pid).toBeGreaterThan(0)
        expect(await manager.cancelInstall(requestId)).toEqual({ status: 'cancelled' })
        expect(await result).toMatchObject({ code: 'plugins/install-cancelled' })
        // A reparented Linux child may remain a zombie until init reaps it; it cannot execute or write.
        let status = ''
        try { status = execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim() } catch (error) {
          if ((error as { status?: number }).status !== 1) throw error
        }
        expect(status === '' || status.startsWith('Z')).toBe(true)
        expect(existsSync(join(staged.profileDir, 'pnpm-lock.yaml'))).toBe(false)
      } finally { await manager.cancelInstall(requestId) }
    })

    it('reports a preparation failure instead of claiming cancellation completed', async () => {
      const staged = await stageHome()
      mkdirSync(join(staged.profileDir, 'pnpm-lock.yaml'))
      const { ctx, manager } = await bootProfile(staged, { spawn: recordingPnpm(staged.profileDir) })
      const requestId = 'f2340b6d-40bb-46b7-8b94-217bdf5010bd' as PluginInstallRequestId
      let cancelled: Promise<unknown> | undefined
      ctx.on('plugins/install-state', (progress) => {
        if (progress.phase === 'installing') cancelled = manager.cancelInstall(requestId).catch((error: unknown) => error)
      })
      const failed = await manager.add('pkg', { requestId }).catch((error: unknown) => error)
      expect(failed).toBeInstanceOf(Error)
      expect(await cancelled).toBe(failed)
      expect(failed).not.toMatchObject({ code: 'plugins/install-cancelled' })
    })

    it('keeps application authoritative when cancellation arrives after preparation', async () => {
      const staged = await stageHome()
      stagePackage(staged.profileDir, 'ext-new', { patch: BUNDLE_ONE_ROW })
      const { ctx, manager } = await bootProfile(staged, { spawn: recordingPnpm(staged.profileDir) })
      const requestId = 'f2340b6d-40bb-46b7-8b94-217bdf5010bd' as PluginInstallRequestId
      let cancel: ReturnType<PluginManager['cancelInstall']> | undefined
      ctx.on('plugins/install-state', (progress) => {
        if (progress.phase === 'applying') cancel = manager.cancelInstall(requestId)
      })
      const answer = await manager.add('ext-new', { requestId, enable: true })
      expect(await cancel).toEqual({ status: 'too-late' })
      expect(answer.enabled).toEqual(['ext-new'])
    })

    it('stops an in-flight installer when its owning plugin is disposed', async () => {
      const staged = await stageHome()
      const started = Promise.withResolvers<undefined>()
      const { ctx, manager } = await bootProfile(staged, { spawn: fakePnpm(staged.profileDir, () => {
        started.resolve(undefined)
        return { code: null, hang: true }
      }) })
      const answer = manager.add('slow').catch((error: unknown) => error)
      await started.promise
      await ctx.fiber.dispose()
      expect(await answer).toMatchObject({ code: 'plugins/install-cancelled' })
    })

    it('refuses a second mutation while one is still running', async () => {
      const staged = await stageHome()
      stagePackage(staged.profileDir, 'ext-slow', { patch: BUNDLE_ONE_ROW })
      let release = (): void => {}
      const gate = new Promise<void>((resolve) => { release = resolve })
      const spawn = fakePnpm(staged.profileDir, (args) => {
        addDependency(staged.profileDir, args[1] ?? 'ext-slow')
        return { code: 0 }
      }, [], gate)
      const { manager } = await bootProfile(staged, { spawn })

      const first = manager.add('ext-slow')
      await expect(manager.enable('ext-slow')).rejects.toMatchObject({
        code: 'plugins/busy', details: { operation: 'enable', active: { operation: 'add', subject: 'ext-slow' } },
      })
      release()
      await expect(first).resolves.toMatchObject({ installed: ['ext-slow'] })
      // The lock is released with the run: the refused call now goes through.
      await expect(manager.enable('ext-slow')).resolves.toMatchObject({ changed: true })
    })

    it('refuses to change node_modules while a session is running', async () => {
      const staged = await stageHome()
      stagePackage(staged.profileDir, 'ext-bundle', { patch: BUNDLE_ONE_ROW })
      addDependency(staged.profileDir, 'ext-bundle')
      const calls: string[][] = []
      const { ctx, manager } = await bootProfile(staged, { spawn: recordingPnpm(staged.profileDir, calls) })
      ctx.provide('agents', { list: () => [{ status: 'running' }, { status: 'idle' }] } as never)

      await expect(manager.add('ext-new')).rejects.toMatchObject({ code: 'plugins/agents-running', details: { operation: 'add', running: 1 } })
      await expect(manager.uninstall('ext-bundle')).rejects.toMatchObject({ code: 'plugins/agents-running', details: { operation: 'uninstall' } })
      expect(calls).toEqual([])
      // Enabling recomposes the tree without touching node_modules.
      await expect(manager.enable('ext-bundle')).resolves.toMatchObject({ changed: true })
    })

    it('runs pnpm add, records the dependency and leaves its bundle disabled', async () => {
      const staged = await stageHome()
      stagePackage(staged.profileDir, 'ext-new', { patch: BUNDLE_ONE_ROW })
      const calls: string[][] = []
      const { manager, changes, log } = await bootProfile(staged, { spawn: recordingPnpm(staged.profileDir, calls) })

      const result = await manager.add('github:acme/ext-new')

      expect(calls).toEqual([['pnpm', 'add', 'github:acme/ext-new']])
      // The fake pnpm records the spec itself as the dependency name, which
      // resolves to nothing: an installed dependency whose declarations cannot be read.
      expect(result).toEqual({ installed: ['github:acme/ext-new'], removed: [], enabled: [], installedOnly: [], plain: ['github:acme/ext-new'], jobId: expect.any(String) as string })
      expect(log.map(chunk => [chunk.argv, chunk.cwd, chunk.stream, chunk.text, chunk.exitCode])).toEqual([
        [['pnpm', 'add', 'github:acme/ext-new'], staged.profileDir, 'stdout', '+ github:acme/ext-new 1.0.0\n', undefined],
        [['pnpm', 'add', 'github:acme/ext-new'], staged.profileDir, 'stdout', '', 0],
      ])
      expect(changes).toEqual([{ reason: 'install' }])
    })

    it('has pnpm colour its output and streams the escapes as they come', async () => {
      const staged = await stageHome()
      stagePackage(staged.profileDir, 'ext-new', { patch: BUNDLE_ONE_ROW })
      const colours: (string | undefined)[] = []
      const pnpm = fakePnpm(staged.profileDir, (args) => {
        addDependency(staged.profileDir, args[1] as string)
        return { code: 0, stdout: '\u001b[32m+\u001b[39m ext-new \u001b[90m1.0.0\u001b[39m\n' }
      })
      const { manager, log } = await bootProfile(staged, {
        spawn: (spec) => {
          colours.push(spec.env?.FORCE_COLOR)
          return pnpm(spec)
        },
      })
      await manager.add('ext-new')
      expect(colours).toEqual(['1'])
      expect(log[0]?.text).toBe('\u001b[32m+\u001b[39m ext-new \u001b[90m1.0.0\u001b[39m\n')
    })

    it('reconciles by the installed name, and enables the new bundle when asked', async () => {
      const staged = await stageHome()
      stagePackage(staged.profileDir, 'ext-new', { patch: BUNDLE_ONE_ROW })
      const { ctx, manager, changes } = await bootProfile(staged, { spawn: recordingPnpm(staged.profileDir) })

      const result = await manager.add('ext-new', { enable: true })

      expect(result).toMatchObject({ installed: ['ext-new'], enabled: ['ext-new'], installedOnly: [], plain: [] })
      expect(manifestOf(staged.profileDir).dsh.profile.bundles).toEqual(['ext-new'])
      expect(entryIds(ctx)).toEqual(expect.arrayContaining(['include:hello']))
      expect(changes.map(change => change.reason)).toEqual(['enable', 'install'])
      expect((await manager.list()).find(view => view.name === 'ext-new')?.status).toBe('running')
    })

    it('reports a plugin module as plain and uninstalls it', async () => {
      const staged = await stageHome()
      stagePackage(staged.profileDir, 'ext-lib', { main: 'export function apply() {}\n' })
      const { manager } = await bootProfile(staged, { spawn: recordingPnpm(staged.profileDir) })

      expect(await manager.add('ext-lib')).toMatchObject({ installed: ['ext-lib'], plain: ['ext-lib'], installedOnly: [], removed: [] })
      expect((await manager.list()).find(view => view.name === 'ext-lib')?.status).toBe('plain')
      await manager.uninstall('ext-lib')
      expect((await manager.list()).some(view => view.name === 'ext-lib')).toBe(false)
    })

    it('installs into a manifest that declares no dependencies yet', async () => {
      const staged = await stageHome()
      writeFileSync(join(staged.profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [], patchReload: 'live' } } }))
      stagePackage(staged.profileDir, 'ext-new', { patch: BUNDLE_ONE_ROW })
      const { manager } = await bootProfile(staged, { spawn: fakePnpm(staged.profileDir, () => {
        const path = join(staged.profileDir, 'package.json')
        const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
        writeFileSync(path, JSON.stringify({ ...manifest, dependencies: { 'ext-new': '1.0.0' } }))
        return { code: 0 }
      }) })

      expect(await manager.add('ext-new')).toMatchObject({ installed: ['ext-new'], installedOnly: ['ext-new'] })
    })

    it('fails loud on a non-zero exit, a spawn error, a timeout, and an empty spec', async () => {
      const staged = await stageHome()
      const exits = await bootProfile(staged, { spawn: fakePnpm(staged.profileDir, () => ({ code: 1, stderr: 'ERR_PNPM_NO_MATCHING_VERSION\n' })) })
      await expect(exits.manager.add('nope')).rejects.toMatchObject({
        code: 'plugins/install-failed', details: { spec: 'nope', exitCode: 1, log: 'ERR_PNPM_NO_MATCHING_VERSION\n' },
      })
      expect(exits.log.at(-1)).toMatchObject({ exitCode: 1 })
      await expect(exits.manager.add('  ')).rejects.toMatchObject({ code: 'plugins/bad-request' })

      const erroringHome = await stageHome()
      const erroring = await bootProfile(erroringHome, { spawn: fakePnpm(erroringHome.profileDir, () => ({ code: null, error: 'spawn pnpm ENOENT' })) })
      await expect(erroring.manager.add('x')).rejects.toMatchObject({ code: 'plugins/install-failed', details: { exitCode: null } })
      expect(erroring.log.some(chunk => chunk.text.includes('ENOENT'))).toBe(true)

      const hangingHome = await stageHome()
      const hanging = await bootProfile(hangingHome, { spawn: fakePnpm(hangingHome.profileDir, () => ({ code: null, hang: true })) })
      await expect(hanging.manager.add('x')).rejects.toMatchObject({ code: 'plugins/install-failed' })
      expect(hanging.log.some(chunk => chunk.text.includes('timed out'))).toBe(true)
    })

    it('keeps only the tail of a long log in the failure', async () => {
      const staged = await stageHome()
      const { manager } = await bootProfile(staged, {
        spawn: fakePnpm(staged.profileDir, () => ({ code: 2, stdout: 'a'.repeat(300), stderr: 'b'.repeat(300) })),
      }, { installLogTailBytes: 256 })
      await expect(manager.add('x')).rejects.toMatchObject({ details: { log: 'b'.repeat(300) } })
    })
  })

  describe('enable, disable, and retry', () => {
    it('composes an installed bundle live, and takes it out again', async () => {
      const staged = await stageHome()
      stagePackage(staged.profileDir, 'ext-bundle', { patch: BUNDLE_ONE_ROW })
      addDependency(staged.profileDir, 'ext-bundle')
      const { ctx, manager, changes } = await bootProfile(staged)

      expect(await manager.enable('ext-bundle')).toEqual({ changed: true, effect: 'live' })
      expect(entryIds(ctx)).toContain('include:hello')
      expect(await manager.enable('ext-bundle')).toEqual({ changed: false, effect: 'live' })
      expect(await manager.disable('ext-bundle')).toEqual({ changed: true, effect: 'live' })
      expect(entryIds(ctx)).not.toContain('include:hello')
      expect(await manager.disable('ext-bundle')).toEqual({ changed: false, effect: 'live' })
      expect(changes.map(change => [change.reason, change.packageName])).toEqual([
        ['enable', 'ext-bundle'], ['enable', 'ext-bundle'], ['disable', 'ext-bundle'], ['disable', 'ext-bundle'],
      ])
    })

    it('only writes the manifest on a startup-reload profile', async () => {
      const staged = await stageHome('startup')
      stagePackage(staged.profileDir, 'ext-bundle', { patch: BUNDLE_ONE_ROW })
      addDependency(staged.profileDir, 'ext-bundle')
      const { ctx, manager } = await bootProfile(staged)

      expect(await manager.enable('ext-bundle')).toEqual({ changed: true, effect: 'restart' })
      expect(manifestOf(staged.profileDir).dsh.profile.bundles).toEqual(['ext-bundle'])
      expect(entryIds(ctx)).not.toContain('include:hello')
      expect(await manager.disable('ext-bundle')).toEqual({ changed: true, effect: 'restart' })
    })

    it('refuses what cannot be enabled or disabled', async () => {
      const staged = await stageHome()
      stagePackage(staged.profileDir, 'ext-lib', { main: 'export const x = 1\n' })
      addDependency(staged.profileDir, 'ext-lib')
      stagePackage(staged.profileDir, 'ext-broken', { patch: BUNDLE_ONE_ROW, main: 'throw new Error("no import for you")\n' })
      addDependency(staged.profileDir, 'ext-broken')
      const { manager } = await bootProfile(staged)

      await expect(manager.enable('absent')).rejects.toMatchObject({ code: 'plugins/not-installed' })
      await expect(manager.enable('ext-lib')).rejects.toMatchObject({ code: 'plugins/not-enableable', details: { reason: expect.stringContaining('declares no dsh.bundle') as string } })
      await expect(manager.enable('ext-broken')).resolves.toMatchObject({ effect: 'live' })
      // A template bundle is not a dependency and cannot be disabled.
      const manifest = manifestOf(staged.profileDir)
      manifest.dsh.profile.bundles.push('template')
      writeFileSync(join(staged.profileDir, 'package.json'), JSON.stringify(manifest, null, 2))
      await expect(manager.disable('template')).rejects.toMatchObject({ code: 'plugins/bad-request' })
      await expect(manager.retry('ext-lib')).rejects.toMatchObject({ code: 'plugins/bad-request' })
    })

    it('retains live enablement and reports failed rows after startup', async () => {
      const staged = await stageHome()
      stagePackage(staged.profileDir, 'ext-fatal', { patch: '- insert:\n    - id: bad\n      name: cordis:throws\n' })
      addDependency(staged.profileDir, 'ext-fatal')
      stagePackage(staged.profileDir, 'ext-fine', { patch: BUNDLE_ONE_ROW })
      addDependency(staged.profileDir, 'ext-fine')
      const { ctx, manager } = await bootProfile(staged)
      await manager.enable('ext-fine')

      const result = await manager.enable('ext-fatal')
      expect(result.effect).toBe('live')
      expect(result.issues?.[0]?.message).toContain('boom at apply')

      expect(manifestOf(staged.profileDir).dsh.profile.bundles).toEqual(['ext-fine', 'ext-fatal'])
      expect(entryIds(ctx)).toContain('include:hello')
      expect(entryIds(ctx)).toContain('include:bad')
    })

    it('retries a bundle by removing and re-adding its layer', async () => {
      const staged = await stageHome()
      stagePackage(staged.profileDir, 'ext-flaky', { patch: '- insert:\n    - id: once\n      name: cordis:flaky\n' })
      addDependency(staged.profileDir, 'ext-flaky')
      flakyCalls = 0
      const { manager, changes } = await bootProfile(staged)
      await manager.enable('ext-flaky')
      expect((await manager.list())[0]).toMatchObject({ status: 'failed', reason: expect.stringContaining('flaky first start') as string })

      expect(await manager.retry('ext-flaky')).toEqual({ changed: true, effect: 'live' })

      expect((await manager.list())[0]).toMatchObject({ status: 'running' })
      expect(changes.map(change => change.reason)).toEqual(['enable', 'disable', 'enable', 'retry'])
    })
  })

  describe('rows in user layers', () => {
    it('persists a startup profile row toggle without changing its mounted tree', async () => {
      const staged = await stageHome('startup')
      stagePackage(staged.profileDir, 'ext-bundle', { patch: BUNDLE_ONE_ROW })
      addDependency(staged.profileDir, 'ext-bundle')
      const manifest = manifestOf(staged.profileDir)
      manifest.dsh.profile.bundles.push('ext-bundle')
      writeFileSync(join(staged.profileDir, 'package.json'), JSON.stringify(manifest))
      const { ctx, manager } = await bootProfile(staged)

      await manager.setRowDisabled('hello', true)

      expect(readFileSync(join(staged.profileDir, 'cordis.patch.yml'), 'utf8')).toContain('disabled: true')
      expect(ctx.loader.resolve('include:hello').disabled).toBe(false)
    })

    it('disables and restores a bundle row through the live user layer', async () => {
      const staged = await stageHome()
      stagePackage(staged.profileDir, 'ext-bundle', { patch: BUNDLE_ONE_ROW })
      addDependency(staged.profileDir, 'ext-bundle')
      const { ctx, manager, changes } = await bootProfile(staged)
      await manager.enable('ext-bundle')
      const file = join(staged.profileDir, 'cordis.patch.yml')

      await manager.setRowDisabled('hello', true)
      expect(ctx.loader.resolve('include:hello').disabled).toBe(true)
      expect(readFileSync(file, 'utf8')).toContain('disabled: true')
      await manager.setRowDisabled('hello', false)
      expect(ctx.loader.resolve('include:hello').disabled).toBe(false)
      expect(readFileSync(file, 'utf8')).not.toContain('disabled')
      expect(changes.map(change => change.reason)).toEqual(['enable', 'row', 'row'])
    })
  })

  describe('dependents and uninstall', () => {
    it('names the services other rows inject and the user-layer rows that reference the package', async () => {
      const staged = await stageHome()
      // Beside the provider: a row nobody injects, and a row switched off (no fiber to read).
      stagePackage(staged.profileDir, 'ext-provider', { patch: '- insert:\n    - id: svc\n      name: cordis:provider\n    - id: lonely\n      name: cordis:lonely-provider\n    - id: off\n      name: cordis:good\n      disabled: true\n' })
      addDependency(staged.profileDir, 'ext-provider')
      writeFileSync(join(staged.profileDir, 'cordis.patch.yml'), [
        '- insert:',
        '    - name: ext-provider/anonymous.js',
        '      disabled: true',
        '    - id: ref',
        '      name: ext-provider/tools/x.js',
        '      disabled: true',
        '    - id: grp',
        '      name: cordis:group',
        '      group: true',
        '      config:',
        '        - id: nested-ref',
        '          name: ext-provider',
        '          disabled: true',
        '',
      ].join('\n'))
      const { manager, runtime } = await bootProfile(staged)
      await manager.enable('ext-provider')
      // A built-in row injecting the bundle's service, composed once the
      // provider is up (a boot would refuse a row left waiting).
      writeFileSync(join(staged.profileDir, 'cordis.patch.yml'), `${readFileSync(join(staged.profileDir, 'cordis.patch.yml'), 'utf8')}- id: svc\n  disabled: false\n- insert:\n    - id: needs-svc\n      name: cordis:consumer\n`)
      await runtime.recompose()

      const dependents = await manager.dependents('ext-provider')

      expect(dependents.services).toEqual([{ service: 'fixtureSvc', providedBy: 'include:svc', injectedBy: ['include:needs-svc'] }])
      expect(dependents.references.map(reference => reference.rowId)).toEqual(['ref', 'nested-ref'])
      expect(dependents.references[0]).toEqual({ rowId: 'ref', moduleName: 'ext-provider/tools/x.js' })
    })

    it('ignores an unreadable user layer while collecting references', async () => {
      const staged = await stageHome()
      stagePackage(staged.profileDir, 'ext-lib', { main: 'export const x = 1\n' })
      addDependency(staged.profileDir, 'ext-lib')
      const { manager } = await bootProfile(staged)
      writeFileSync(join(staged.profileDir, 'cordis.patch.yml'), 'a: [\n')

      expect((await manager.dependents('ext-lib')).references).toEqual([])
    })

    it('disables a bundle and removes references from a handwritten user patch before uninstalling', async () => {
      const staged = await stageHome()
      stagePackage(staged.profileDir, 'ext-bundle', { patch: BUNDLE_ONE_ROW, files: { 'extra.js': 'export function apply() {}\n' } })
      addDependency(staged.profileDir, 'ext-bundle')
      const calls: string[][] = []
      const { ctx, manager, changes } = await bootProfile(staged, { spawn: recordingPnpm(staged.profileDir, calls) })
      await manager.enable('ext-bundle')
      writeFileSync(join(staged.profileDir, 'cordis.patch.yml'), '- insert:\n    - id: ext-bundle/extra.js\n      name: ext-bundle/extra.js\n')
      await ctx.profileRuntime.recompose()
      expect(entryIds(ctx)).toEqual(expect.arrayContaining(['include:hello', 'include:ext-bundle/extra.js']))

      await manager.uninstall('ext-bundle')

      expect(calls).toEqual([['pnpm', 'remove', 'ext-bundle']])
      expect(manifestOf(staged.profileDir)).toMatchObject({ dependencies: {}, dsh: { profile: { bundles: [] } } })
      expect(entryIds(ctx)).not.toContain('include:hello')
      expect(entryIds(ctx)).not.toContain('include:ext-bundle/extra.js')
      expect(readFileSync(join(staged.profileDir, 'cordis.patch.yml'), 'utf8')).toBe('[]\n')
      expect(changes.map(change => change.reason)).toEqual(['enable', 'disable', 'uninstall'])
      await expect(manager.uninstall('ext-bundle')).rejects.toMatchObject({ code: 'plugins/not-installed' })
    })
  })
})

describe('PluginOperationError', () => {
  it('carries its code and details, and is what pluginOperationFailureOf narrows to', () => {
    const failure = new PluginOperationError('plugins/not-installed', 'absent', { packageName: 'x' })
    expect(failure).toMatchObject({ name: 'PluginOperationError', code: 'plugins/not-installed', message: 'absent', details: { packageName: 'x' } })
    expect(pluginOperationFailureOf(failure)).toBe(failure)
    expect(pluginOperationFailureOf(new Error('plain'))).toBeUndefined()
  })
})
