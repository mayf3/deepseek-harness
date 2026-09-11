/**
 * The plugin manager over a real profile: a temporary harness home with one
 * profile, packages staged the way pnpm leaves them, the host tree booted
 * through `boot()` with the profile runtime the launcher provides, and a
 * fake pnpm that edits the profile the way the real one does. The manager
 * is built the way the Web host's adapter builds it, reading the runtime,
 * the roster, and the agent registry off the context per call.
 */

import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, type Plugin } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import {
  boot, composeProfileStack, loadOptionalPatches, loadProfile, ProfileRuntime, rootIncludeEntry,
  type ComposedStack, type Profile, type readPackageMetadata,
} from '@deepseek-ai/dsh-app-boot'
import {
  PluginManager, type PluginInstallLogChunk, type PluginToolingConfig, type SpawnLike,
} from '@deepseek-ai/dsh-plugin-manager'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'

const NAME = 'dsh-test'

/** A complete tooling config: the host's schema fills these defaults at load, the type does not. */
function managerConfig(overrides: Partial<PluginToolingConfig> = {}): PluginToolingConfig {
  return { pnpmCommand: 'pnpm', installTimeoutMs: 1_000, installLogTailBytes: 16_384, ...overrides }
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
  /** Any string: a staged manifest may declare a stage the profile refuses. */
  stage?: string
  plugins?: { name: string; title?: string; config?: unknown }[]
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
      ...staged.patch === undefined ? {} : { bundle: { patch: './cordis.patch.yml', ...staged.stage === undefined ? {} : { stage: staged.stage } } },
      ...staged.plugins === undefined ? {} : { plugins: staged.plugins },
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
function fakePnpm(profileDir: string, behavior: PnpmBehavior, calls: string[][] = []): SpawnLike {
  return (command, args, options) => {
    calls.push([command, ...args])
    expect(options.cwd).toBe(profileDir)
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: (signal?: string) => boolean }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    let killed = false
    child.kill = () => { killed = true; return true }
    setTimeout(() => {
      const outcome = behavior(args)
      if (outcome.error !== undefined) {
        child.emit('error', outcome.error)
        return
      }
      if (outcome.stdout !== undefined) child.stdout.write(outcome.stdout)
      if (outcome.stderr !== undefined) child.stderr.write(outcome.stderr)
      if (outcome.hang === true) {
        // Report the kill the timeout sends, as a real child would.
        const poll = setInterval(() => {
          if (!killed) return
          clearInterval(poll)
          child.emit('close', null)
        }, 10)
        return
      }
      setTimeout(() => { child.emit('close', outcome.code) }, 5)
    }, 5)
    return child as unknown as ChildProcess
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
    const stack = composeProfileStack(NAME, profile.layers, [
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
  const manager = managerOver(ctx, internals, config)
  return { ctx, manager, runtime: ctx.profileRuntime, changes, log }
}

/** The manager as the Web host's adapter builds it: runtime, roster, and agent count read off the context per call. */
function managerOver(ctx: Context, internals: Internals = {}, config: Partial<PluginToolingConfig> = {}): PluginManager {
  return new PluginManager(ctx, {
    config: managerConfig(config),
    runtime: () => ctx.get('profileRuntime'),
    presets: () => ctx.get('agentPresets'),
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
    stagePackage(staged.profileDir, 'clash', { patch: BUNDLE_ONE_ROW, stage: 'boot' })
    addDependency(staged.profileDir, 'clash')
    const { ctx, manager } = await bootProfile(staged)
    await expect(manager.enable('clash')).rejects.toMatchObject({ code: 'plugins/enable-failed' })
    expect(manifestOf(staged.profileDir).dsh.profile.bundles).toEqual(['base'])
    expect(ctx.loader.resolve('include:hello').fiber?.state).toBe(2)
  })

  it('does not execute a declared main module during install or list and refuses an undeclared entry', async () => {
    const staged = await stageHome()
    const marker = join(staged.profileDir, 'executed')
    stagePackage(staged.profileDir, 'declared', {
      plugins: [{ name: '.', config: { custom: 1 } }],
      main: `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'bad'); export function apply() {}`,
    })
    stagePackage(staged.profileDir, 'unknown', { main: 'export function apply() {}' })
    const { manager } = await bootProfile(staged, { spawn: recordingPnpm(staged.profileDir) })
    await manager.add('declared')
    await manager.add('unknown')
    const views = await manager.list()
    expect(views.find(view => view.name === 'declared')?.addable[0]).toMatchObject({ moduleName: 'declared', config: { custom: 1 } })
    expect(existsSync(marker)).toBe(false)
    for (const id of ['', 'nested:child']) {
      await expect(manager.addRow('declared', { kind: 'global' }, { id })).rejects.toMatchObject({ code: 'plugins/bad-request' })
    }
    const added = await manager.addRow('declared', { kind: 'global' }, { config: null })
    expect(readFileSync(added.file, 'utf8')).toContain('config: null')
    expect(views.find(view => view.name === 'unknown')?.kind).toBe('unknown')
    await expect(manager.addRow('unknown', { kind: 'global' })).rejects.toMatchObject({ code: 'plugins/not-enableable' })
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
      stagePackage(staged.profileDir, 'ext-bundle', { patch: BUNDLE_ONE_ROW, plugins: [{ name: './extra.js', title: 'Extra' }], files: { 'extra.js': 'export const name = "extra"\nexport function apply() {}\n' } })
      stagePackage(staged.profileDir, 'ext-lib', { main: 'export const x = 1\n' })
      stagePackage(staged.profileDir, 'ext-plugin', { plugins: [{ name: '.' }], main: 'export const name = "p"\nexport function apply() {}\n' })
      addDependency(staged.profileDir, 'ext-bundle')
      addDependency(staged.profileDir, 'ext-lib')
      addDependency(staged.profileDir, 'ext-plugin')
      const { manager } = await bootProfile(staged)

      const views = await manager.list()

      expect(views.map(view => [view.name, view.kind, view.status, view.installed, view.enabled, view.trust])).toEqual([
        ['ext-bundle', 'bundle', 'disabled', true, false, 'external'],
        ['ext-lib', 'unknown', 'plain', true, false, 'external'],
        ['ext-plugin', 'plugin', 'plain', true, false, 'external'],
      ])
      const bundle = views[0]
      expect(bundle).toMatchObject({ version: '1.0.0', title: 'Title of ext-bundle', description: 'staged ext-bundle', stage: 'runtime', liveReload: true })
      // Rows come from static declarations while the bundle is not composed, under the ids the patch declares.
      expect(bundle?.rows).toEqual([{ entryId: 'hello', rowId: 'hello', moduleName: 'cordis:good', enabled: true, phase: null }])
      expect(bundle?.addable).toEqual([{ moduleName: 'ext-bundle/extra.js', declaredName: './extra.js', title: 'Extra' }])
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

    it('reports unreadable declarations and treats physical peer identity as advisory', async () => {
      const staged = await stageHome()
      stagePackage(staged.profileDir, 'ext-odd', { patch: BUNDLE_ONE_ROW })
      addDependency(staged.profileDir, 'ext-odd')
      stagePackage(staged.profileDir, 'ext-refused', { patch: BUNDLE_ONE_ROW })
      addDependency(staged.profileDir, 'ext-refused')
      const { manager } = await bootProfile(staged, {
        metadata: ({ packageName }) => {
          if (packageName === 'ext-odd') throw new Error('invalid declarations')
          return { packageName, kind: 'bundle', cordisSameCopy: false, rows: [], overrides: [], addable: [] }
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
      expect((await manager.list()).map(view => [view.name, view.trust, view.status, view.installed, view.rows.length])).toEqual([['tpl', 'builtin', 'running', false, 1]])
      // A manifest with no dsh section at all knows no bundles.
      writeFileSync(join(staged.profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web' }))
      expect(await manager.list()).toEqual([])

      // Bundles the manifest names after boot: one staged, one that resolves to nothing.
      stagePackage(staged.profileDir, 'tpl-later', { patch: BUNDLE_ONE_ROW })
      writeFileSync(join(staged.profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: ['tpl', 'tpl-later', 'ghost'], patchReload: 'startup' } } }))
      const views = await manager.list()
      expect(views.map(view => [view.name, view.trust, view.kind, view.status])).toEqual([
        ['tpl', 'builtin', 'bundle', 'running'],
        ['tpl-later', 'builtin', 'bundle', 'restart-required'],
        ['ghost', 'builtin', 'unknown', 'plain'],
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
      await manager.setRowDisabled({ kind: 'global' }, 'b', true)

      const views = await manager.list()

      const off = views.find(view => view.name === 'ext-off')
      expect(off).toMatchObject({ status: 'running' })
      expect(off?.rows.map(row => [row.rowId, row.enabled, row.disabledBy, row.phase])).toEqual([
        ['a', false, 'composition', null],
        ['b', false, 'user', null],
      ])
      await manager.setRowDisabled({ kind: 'global' }, 'b', true)
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
      stagePackage(staged.profileDir, 'fp-bundle', { patch: BUNDLE_ONE_ROW })
      addDependency(staged.profileDir, 'fp-bundle')
      const manifest = JSON.parse(readFileSync(join(staged.profileDir, 'package.json'), 'utf8')) as { dsh: { profile: Record<string, unknown> } }
      manifest.dsh.profile.firstParty = ['fp-bundle']
      writeFileSync(join(staged.profileDir, 'package.json'), JSON.stringify(manifest))
      const { manager } = await bootProfile(staged)

      const views = await manager.list()

      expect(views.find(view => view.name === 'ext-anon')?.rows).toEqual([
        { entryId: 'cordis:good', rowId: 'cordis:good', moduleName: 'cordis:good', enabled: true, phase: null },
        { entryId: 'gated', rowId: 'gated', moduleName: 'cordis:good', enabled: false, disabledBy: 'composition', phase: null },
      ])
      await manager.enable('fp-bundle')
      const firstParty = (await manager.list()).find(view => view.name === 'fp-bundle')
      expect(firstParty).toMatchObject({ trust: 'builtin', status: 'running' })
      expect(firstParty?.rows.map(row => row.entryId)).toEqual(['include:hello'])
      await manager.disable('fp-bundle')
      expect((await manager.list()).find(view => view.name === 'fp-bundle')?.rows.map(row => row.entryId)).toEqual(['hello'])
    })
  })

  describe('install', () => {
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

    it('removes an installed bundle the profile cannot resolve and says why', async () => {
      const staged = await stageHome()
      // The static reader reads the manifest without judging the stage; resolving the
      // layer is what refuses it, and that refusal is the removal's reason.
      stagePackage(staged.profileDir, 'ext-odd', { patch: BUNDLE_ONE_ROW, stage: 'weird' })
      const calls: string[][] = []
      const { manager } = await bootProfile(staged, { spawn: recordingPnpm(staged.profileDir, calls) })

      const result = await manager.add('ext-odd')

      expect(result).toMatchObject({
        installed: [], installedOnly: [],
        removed: [{ name: 'ext-odd', reason: expect.stringContaining('declares stage "weird"') as string }],
      })
      expect(calls).toEqual([['pnpm', 'add', 'ext-odd'], ['pnpm', 'remove', 'ext-odd']])
      expect(manifestOf(staged.profileDir).dependencies).not.toHaveProperty('ext-odd')
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

    it('refuses a second mutation while one is still running', async () => {
      const staged = await stageHome()
      stagePackage(staged.profileDir, 'ext-slow', { patch: BUNDLE_ONE_ROW })
      let release = (): void => {}
      const gate = new Promise<void>((resolve) => { release = resolve })
      const spawn: SpawnLike = (_command, args) => {
        const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean }
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        child.kill = () => true
        void gate.then(() => {
          addDependency(staged.profileDir, args[1] ?? 'ext-slow')
          child.emit('close', 0)
        })
        return child as unknown as ChildProcess
      }
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
        spawn: (command, args, options) => {
          colours.push(options.env?.FORCE_COLOR)
          return pnpm(command, args, options)
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

    it('retains live enablement and reports failed boot-stage rows after startup', async () => {
      const staged = await stageHome()
      stagePackage(staged.profileDir, 'ext-fatal', { patch: '- insert:\n    - id: bad\n      name: cordis:throws\n', stage: 'boot' })
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
    it('adds, disables, re-enables, and removes a row in the live global layer', async () => {
      const staged = await stageHome()
      stagePackage(staged.profileDir, '@acme/ext-plugin', { plugins: [{ name: '.' }], main: 'export const name = "p"\nexport function apply() {}\n' })
      addDependency(staged.profileDir, '@acme/ext-plugin')
      const { ctx, manager, changes } = await bootProfile(staged)

      const added = await manager.addRow('@acme/ext-plugin', { kind: 'global' })

      expect(added).toEqual({ target: { kind: 'global' }, rowId: 'acme/ext-plugin', file: join(staged.profileDir, 'cordis.patch.yml') })
      expect(readFileSync(added.file, 'utf8')).toBe('- insert:\n    - id: acme/ext-plugin\n      name: "@acme/ext-plugin"\n      config: {}\n')
      // Composed live: the row is in the tree, though its module cannot import from the temp home.
      expect(entryIds(ctx)).toContain('include:acme/ext-plugin')
      await expect(manager.addRow('@acme/ext-plugin', { kind: 'global' })).rejects.toMatchObject({ code: 'plugins/row-conflict' })

      await manager.setRowDisabled({ kind: 'global' }, 'acme/ext-plugin', true)
      expect(ctx.loader.resolve('include:acme/ext-plugin')?.disabled).toBe(true)
      expect(readFileSync(added.file, 'utf8')).toContain('- id: acme/ext-plugin\n  disabled: true\n')
      await manager.setRowDisabled({ kind: 'global' }, 'acme/ext-plugin', false)
      expect(ctx.loader.resolve('include:acme/ext-plugin')?.disabled).toBe(false)
      expect(readFileSync(added.file, 'utf8')).not.toContain('disabled')

      await manager.removeRow({ kind: 'global' }, 'acme/ext-plugin')
      expect(entryIds(ctx)).not.toContain('include:acme/ext-plugin')
      await expect(manager.removeRow({ kind: 'global' }, 'acme/ext-plugin')).rejects.toMatchObject({ code: 'plugins/bad-request' })
      expect(changes.map(change => change.reason)).toEqual(['row', 'row', 'row', 'row'])
    })

    it('detects a conflict through the layer file when the tree was not recomposed', async () => {
      const staged = await stageHome('startup')
      stagePackage(staged.profileDir, 'ext-plugin', { plugins: [{ name: '.' }], main: 'export const name = "p"\nexport function apply() {}\n' })
      addDependency(staged.profileDir, 'ext-plugin')
      const { ctx, manager } = await bootProfile(staged)

      await manager.addRow('ext-plugin', { kind: 'global' })

      expect(entryIds(ctx)).not.toContain('include:ext-plugin')
      await expect(manager.addRow('ext-plugin', { kind: 'global' })).rejects.toMatchObject({ code: 'plugins/row-conflict' })
    })

    it('adds a declared addable module with its default config and an explicit id, and refuses the rest', async () => {
      const staged = await stageHome()
      stagePackage(staged.profileDir, 'ext-bundle', {
        patch: BUNDLE_ONE_ROW,
        plugins: [
          { name: './tools/sql.js', title: 'SQL', config: { dsn: 'sqlite://' } },
          { name: './missing.js' },
        ],
        files: { 'tools/sql.js': 'export const name = "sql"\nexport function apply() {}\n' },
      })
      addDependency(staged.profileDir, 'ext-bundle')
      const { manager } = await bootProfile(staged)

      const added = await manager.addRow('ext-bundle', { kind: 'global' }, { module: './tools/sql.js', id: 'sql' })
      expect(added.rowId).toBe('sql')
      expect(readFileSync(added.file, 'utf8')).toContain('- id: sql\n      name: ext-bundle/tools/sql.js\n      config:\n        dsn: sqlite://\n')
      await expect(manager.addRow('ext-bundle', { kind: 'global' })).rejects.toMatchObject({ code: 'plugins/not-enableable' })
      await expect(manager.addRow('ext-bundle', { kind: 'global' }, { module: './missing.js' })).resolves.toMatchObject({ rowId: 'ext-bundle/missing.js' })
      await expect(manager.addRow('absent', { kind: 'global' })).rejects.toMatchObject({ code: 'plugins/not-installed' })
    })

    it('writes a preset\'s layer through the roster, and refuses a preset target without one', async () => {
      const staged = await stageHome()
      stagePackage(staged.profileDir, 'ext-plugin', { plugins: [{ name: '.' }], main: 'export const name = "p"\nexport function apply() {}\n' })
      addDependency(staged.profileDir, 'ext-plugin')
      const { ctx, manager } = await bootProfile(staged)
      await expect(manager.addRow('ext-plugin', { kind: 'preset', preset: 'standard' })).rejects.toMatchObject({ code: 'plugins/unavailable' })

      const overlay = join(staged.home, '.agent-presets', 'standard', 'cordis.patch.yml')
      const roster = {
        overlayPathFor: (id: string) => Promise.resolve(join(staged.home, '.agent-presets', id, 'cordis.patch.yml')),
        compositionInventory: () => Promise.resolve([{ id: 'standard', rows: [{ entryId: 'tool-web' }] }]),
        list: () => Promise.resolve([{ id: 'standard', overlayPath: existsSync(overlay) ? overlay : undefined }]),
      }
      ctx.provide('agentPresets', roster)
      // No layer exists yet: nothing references the package.
      expect((await manager.dependents('ext-plugin')).references).toEqual([])
      // A preset the inventory does not know has no rows to conflict with.
      const elsewhere = await manager.addRow('ext-plugin', { kind: 'preset', preset: 'other' })
      expect(elsewhere.file).toBe(join(staged.home, '.agent-presets', 'other', 'cordis.patch.yml'))

      const added = await manager.addRow('ext-plugin', { kind: 'preset', preset: 'standard' })
      expect(added).toEqual({ target: { kind: 'preset', preset: 'standard' }, rowId: 'ext-plugin', file: overlay })
      await expect(manager.addRow('ext-plugin', { kind: 'preset', preset: 'standard' }, { id: 'tool-web' })).rejects.toMatchObject({ code: 'plugins/row-conflict' })
      await manager.setRowDisabled({ kind: 'preset', preset: 'standard' }, 'tool-web', true)
      expect(readFileSync(overlay, 'utf8')).toBe('- insert:\n    - id: ext-plugin\n      name: ext-plugin\n      config: {}\n- id: tool-web\n  disabled: true\n')
      // The preset's layer is not part of the host tree.
      expect(entryIds(ctx)).not.toContain('include:ext-plugin')

      const dependents = await manager.dependents('ext-plugin')
      expect(dependents.references).toEqual([{ target: { kind: 'preset', preset: 'standard' }, rowId: 'ext-plugin', moduleName: 'ext-plugin' }])
      await manager.removeRow({ kind: 'preset', preset: 'standard' }, 'ext-plugin')
      expect(readFileSync(overlay, 'utf8')).toBe('- id: tool-web\n  disabled: true\n')
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
      writeFileSync(join(staged.profileDir, 'cordis.patch.yml'), `${readFileSync(join(staged.profileDir, 'cordis.patch.yml'), 'utf8')}- insert:\n    - id: needs-svc\n      name: cordis:consumer\n`)
      await runtime.recompose()

      const dependents = await manager.dependents('ext-provider')

      expect(dependents.services).toEqual([{ service: 'fixtureSvc', providedBy: 'include:svc', injectedBy: ['include:needs-svc'] }])
      expect(dependents.references.map(reference => reference.rowId)).toEqual(['ref', 'nested-ref'])
      expect(dependents.references[0]).toEqual({ target: { kind: 'global' }, rowId: 'ref', moduleName: 'ext-provider/tools/x.js' })
    })

    it('ignores an unreadable user layer while collecting references', async () => {
      const staged = await stageHome()
      stagePackage(staged.profileDir, 'ext-lib', { main: 'export const x = 1\n' })
      addDependency(staged.profileDir, 'ext-lib')
      const { manager } = await bootProfile(staged)
      writeFileSync(join(staged.profileDir, 'cordis.patch.yml'), 'a: [\n')

      expect((await manager.dependents('ext-lib')).references).toEqual([])
    })

    it('disables, drops references, removes the package, and forgets its probe', async () => {
      const staged = await stageHome()
      stagePackage(staged.profileDir, 'ext-bundle', { patch: BUNDLE_ONE_ROW, plugins: [{ name: './extra.js' }], files: { 'extra.js': 'export function apply() {}\n' } })
      addDependency(staged.profileDir, 'ext-bundle')
      const calls: string[][] = []
      const { ctx, manager, changes } = await bootProfile(staged, { spawn: recordingPnpm(staged.profileDir, calls) })
      await manager.enable('ext-bundle')
      await manager.addRow('ext-bundle', { kind: 'global' }, { module: './extra.js' })
      expect(entryIds(ctx)).toEqual(expect.arrayContaining(['include:hello', 'include:ext-bundle/extra.js']))

      await manager.uninstall('ext-bundle')

      expect(calls).toEqual([['pnpm', 'remove', 'ext-bundle']])
      expect(manifestOf(staged.profileDir)).toMatchObject({ dependencies: {}, dsh: { profile: { bundles: [] } } })
      expect(entryIds(ctx)).not.toContain('include:hello')
      expect(entryIds(ctx)).not.toContain('include:ext-bundle/extra.js')
      expect(readFileSync(join(staged.profileDir, 'cordis.patch.yml'), 'utf8')).toBe('[]\n')
      expect(changes.map(change => change.reason)).toEqual(['enable', 'row', 'disable', 'uninstall'])
      await expect(manager.uninstall('ext-bundle')).rejects.toMatchObject({ code: 'plugins/not-installed' })
    })
  })
})
