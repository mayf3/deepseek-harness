import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveDesktopPaths } from '../src/paths.ts'
import { DesktopProjectManager, packageNameFromSpec, type DesktopProjectHooks } from '../src/project-manager.ts'
import { readDesktopProfileState } from '../src/profile-packages.ts'
import { runtimeFixture } from './runtime-fixture.ts'

const roots: string[] = []
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-test-'))
  roots.push(root)
  return root
}
function writeFakePnpm(root: string): string {
  const path = join(root, 'pnpm.mjs')
  writeFileSync(path, `
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
const project = process.cwd()
const command = args.find(value => ['install', 'add', 'remove', 'rebuild'].includes(value))
appendFileSync(${JSON.stringify(join(root, 'pnpm-log.jsonl'))}, JSON.stringify({args, registry: process.env.NPM_CONFIG_REGISTRY}) + '\\n')
if (command !== 'rebuild') {
  const manifestPath = join(project, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (command === 'add') {
    const spec = args[args.indexOf(command) + 1]
    const index = spec.lastIndexOf('@')
    const name = index > 0 ? spec.slice(0, index) : spec
    manifest.dependencies[name] = index > 0 ? spec.slice(index + 1) : '1.0.0'
  }
  if (command === 'remove') delete manifest.dependencies[args[args.indexOf(command) + 1]]
  writeFileSync(manifestPath, JSON.stringify(manifest))
  rmSync(join(project, 'node_modules'), { recursive: true, force: true })
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    const packageRoot = join(project, 'node_modules', name)
    mkdirSync(packageRoot, { recursive: true })
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({name, version,
      peerDependencies: {'@deepseek-ai/cordis': '^1.0.0'}, dsh: {bundle: {patch: './bundle.yml'}}}))
    writeFileSync(join(packageRoot, 'bundle.yml'), '[]\\n')
  }
  writeFileSync(join(project, 'pnpm-lock.yaml'), JSON.stringify(manifest.dependencies))
}
`)
  return path
}
function hooks(overrides: Partial<DesktopProjectHooks> = {}): DesktopProjectHooks {
  return { beforeActivate: async () => {}, afterActivate: async () => {}, ...overrides }
}
function setup(): { root: string; manager: DesktopProjectManager } {
  const root = temporaryRoot()
  const dsh = join(root, 'resources', 'dsh')
  runtimeFixture(dsh)
  return { root, manager: new DesktopProjectManager(resolveDesktopPaths(join(root, '.dsh')), { node: process.execPath, pnpm: writeFakePnpm(root), dsh }) }
}
function calls(root: string): { args: string[]; registry: string }[] {
  const path = join(root, 'pnpm-log.jsonl')
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { args: string[]; registry: string }) : []
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('desktop external plugin profile', () => {
  it('accepts registry names and tags but rejects alternate sources and flags', () => {
    expect(packageNameFromSpec('@scope/plugin@1.2.3')).toBe('@scope/plugin')
    expect(packageNameFromSpec('plugin@next')).toBe('plugin')
    for (const spec of ['file:../plugin', '--registry=evil', 'https://example.test/plugin.tgz']) {
      expect(() => packageNameFromSpec(spec)).toThrow(/unsupported npm package spec/u)
    }
  })

  it('initializes and restarts offline without executing pnpm', async () => {
    const { root, manager } = setup()
    await expect(manager.applyRelease('2.0.0', hooks())).rejects.toThrow(/does not match Electron/u)
    await expect(manager.applyRelease('1.0.0', hooks())).resolves.toBe(true)
    await expect(manager.applyRelease('1.0.0', hooks())).resolves.toBe(false)
    expect(manager.listPlugins()).toEqual([])
    expect(calls(root)).toEqual([])
    expect(existsSync(manager.paths.pnpm.store)).toBe(false)
    expect(realpathSync(join(manager.paths.profile, 'node_modules/@deepseek-ai/cordis'))).toBe(realpathSync(join(manager.runtime.dsh, 'node_modules/@deepseek-ai/cordis')))
    expect(JSON.parse(readFileSync(join(manager.paths.profile, 'package.json'), 'utf8'))).toMatchObject({ dependencies: {} })
  })

  it('repairs a removed managed link without running pnpm', async () => {
    const { root, manager } = setup()
    await manager.applyRelease('1.0.0', hooks())
    unlinkSync(join(manager.paths.profile, 'node_modules/@deepseek-ai/cordis'))
    await expect(manager.applyRelease('1.0.0', hooks())).resolves.toBe(true)
    expect(calls(root)).toEqual([])
  })

  it.skipIf(process.platform !== 'win32')('reuses the profile when the launch path changes only Windows letter casing', async () => {
    const { manager } = setup()
    await manager.applyRelease('1.0.0', hooks())
    const relaunched = new DesktopProjectManager(manager.paths, { ...manager.runtime, dsh: manager.runtime.dsh.toUpperCase() })
    let started = false
    await expect(relaunched.applyRelease('1.0.0', hooks({
      afterActivate: async () => { started = true },
    }))).resolves.toBe(false)
    expect(started).toBe(false)
  })

  it.each(['changed', 'same-size', 'extra', 'missing'])('starts and reuses a profile without checking %s runtime bytes', async (operation) => {
    const { root, manager } = setup()
    if (operation === 'changed') writeFileSync(join(manager.runtime.dsh, 'package.json'), '{}')
    if (operation === 'same-size') writeFileSync(join(manager.runtime.dsh, 'package.json'), '{"type":"Module"}\n')
    if (operation === 'extra') writeFileSync(join(manager.runtime.dsh, 'extra'), '')
    if (operation === 'missing') unlinkSync(join(manager.runtime.dsh, 'package.json'))
    let starts = 0
    await expect(manager.applyRelease('1.0.0', hooks({
      afterActivate: async () => { starts++ },
    }))).resolves.toBe(true)
    const relaunched = new DesktopProjectManager(manager.paths, manager.runtime)
    await expect(relaunched.applyRelease('1.0.0', hooks({
      afterActivate: async () => { starts++ },
    }))).resolves.toBe(false)
    expect(starts).toBe(1)
    expect(existsSync(manager.paths.profile)).toBe(true)
    expect(calls(root)).toEqual([])
  })

  it('installs only plugins and checks the graph before running lifecycle scripts', async () => {
    const { root, manager } = setup()
    await manager.applyRelease('1.0.0', hooks())
    await manager.mutate({ type: 'plugin-add', spec: '@scope/plugin@2.0.0' }, hooks())
    expect(manager.listPlugins()).toEqual([{ name: '@scope/plugin', version: '2.0.0', enabled: true }])
    expect(calls(root).map(call => call.args.filter(arg => !arg.startsWith('--config.')))).toEqual([
      ['add', '@scope/plugin@2.0.0', '--save-exact', '--ignore-scripts'], ['rebuild', '--pending'],
    ])
    expect(calls(root).every(call => call.registry === 'https://registry.npmjs.org/')).toBe(true)
    expect(JSON.parse(readFileSync(join(manager.paths.profile, 'package.json'), 'utf8'))).toMatchObject({ dependencies: { '@scope/plugin': '2.0.0' } })
    await expect(manager.mutate({ type: 'plugin-add', spec: '@deepseek-ai/cordis' }, hooks())).rejects.toThrow(/host-owned/u)
  })

  it('retains disabled plugin versions through updates and enables them explicitly', async () => {
    const { root, manager } = setup()
    await manager.applyRelease('1.0.0', hooks())
    await manager.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks())
    await manager.mutate({ type: 'plugins-disable-all' }, hooks())
    expect(calls(root)).toHaveLength(2)
    expect(manager.listPlugins()).toEqual([{ name: 'plugin', version: '1.0.0', enabled: false }])
    await manager.mutate({ type: 'plugin-update', name: 'plugin', version: '1.1.0' }, hooks())
    expect(manager.listPlugins()).toEqual([{ name: 'plugin', version: '1.1.0', enabled: false }])
    await manager.mutate({ type: 'plugin-toggle', name: 'plugin', enabled: true }, hooks())
    expect(manager.listPlugins()[0]?.enabled).toBe(true)
    await manager.mutate({ type: 'plugin-remove', name: 'plugin' }, hooks())
    expect(manager.listPlugins()).toEqual([])
  })

  it('keeps plugin files and patches through a compatible release and application relocation', async () => {
    const { root, manager } = setup()
    await manager.applyRelease('1.0.0', hooks())
    await manager.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks())
    writeFileSync(join(manager.paths.profile, 'cordis.patch.yml'), '[]\n')
    const nextRoot = join(root, 'relocated', 'dsh')
    runtimeFixture(nextRoot, '1.1.0')
    const next = new DesktopProjectManager(manager.paths, { ...manager.runtime, dsh: nextRoot })
    await expect(next.applyRelease('1.1.0', hooks())).resolves.toBe(true)
    expect(next.listPlugins()).toEqual(manager.listPlugins())
    expect(next.releaseVersion()).toBe('1.1.0')
    expect(readFileSync(join(manager.paths.profile, 'cordis.patch.yml'), 'utf8')).toBe('[]\n')
    expect(calls(root)).toHaveLength(2)
    expect(realpathSync(join(manager.paths.profile, 'node_modules/@deepseek-ai/cordis'))).toBe(realpathSync(join(nextRoot, 'node_modules/@deepseek-ai/cordis')))
    writeFileSync(join(manager.paths.rollback, 'node_modules/plugin/bundle.yml'), 'rollback only')
    expect(readFileSync(join(manager.paths.profile, 'node_modules/plugin/bundle.yml'), 'utf8')).toBe('[]\n')
  })

  it('reinstalls the locked plugin graph when bundled Node changes', async () => {
    const { root, manager } = setup()
    await manager.applyRelease('1.0.0', hooks())
    await manager.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks())
    const dsh = join(root, 'new-node')
    runtimeFixture(dsh, '1.1.0', '24.18.0')
    const next = new DesktopProjectManager(manager.paths, { ...manager.runtime, dsh })
    await next.applyRelease('1.1.0', hooks())
    expect(calls(root).slice(2).map(call => call.args.filter(arg => !arg.startsWith('--config.')))).toEqual([
      ['install', '--frozen-lockfile', '--ignore-scripts'], ['rebuild', '--pending'],
    ])
    expect(next.listPlugins()).toEqual([{ name: 'plugin', version: '1.0.0', enabled: true }])
  })

  it('allows incompatible plugins to be disabled in recovery without deleting them', async () => {
    const { root, manager } = setup()
    await manager.applyRelease('1.0.0', hooks())
    await manager.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks())
    const dsh = join(root, 'next-major')
    runtimeFixture(dsh, '2.0.0')
    const next = new DesktopProjectManager(manager.paths, { ...manager.runtime, dsh })
    await expect(next.applyRelease('2.0.0', hooks())).rejects.toThrow(/requires @deepseek-ai\/cordis/u)
    expect(next.releaseVersion()).toBe('1.0.0')
    expect(() =>{  next.assertProfileRuntime(manager.paths.profile) }).toThrow(/does not match/u)
    await next.mutate({ type: 'plugins-disable-all' }, hooks())
    expect(next.releaseVersion()).toBe('2.0.0')
    expect(next.listPlugins()).toEqual([{ name: 'plugin', version: '1.0.0', enabled: false }])
  })

  it.each(['before', 'after'] as const)('keeps the active profile when %s activation fails', async (phase) => {
    const { manager } = setup()
    await manager.applyRelease('1.0.0', hooks())
    let starts = 0
    await expect(manager.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks({
      beforeActivate: async () => { if (phase === 'before') throw new Error('before failed') },
      afterActivate: async () => { if (phase === 'after' && starts++ === 0) throw new Error('after failed') },
    }))).rejects.toThrow(`${phase} failed`)
    expect(manager.listPlugins()).toEqual([])
    expect(existsSync(manager.paths.pending)).toBe(false)
  })

  it('recovers a directory move using recorded runtime identities', async () => {
    const { manager } = setup()
    await manager.applyRelease('1.0.0', hooks())
    const id = readDesktopProfileState(manager.paths.profile)?.runtimeId
    const stagingProfile = join(manager.paths.staging, 'interrupted', 'profile')
    mkdirSync(stagingProfile, { recursive: true })
    mkdirSync(dirname(manager.paths.rollback), { recursive: true })
    renameSync(manager.paths.profile, manager.paths.rollback)
    writeFileSync(manager.paths.pending, JSON.stringify({ schemaVersion: 1, id: 'interrupted', stagingProfile, fromRuntimeId: id, toRuntimeId: id, step: 'active-moved' }))
    manager.recover()
    expect(manager.releaseVersion()).toBe('1.0.0')
    expect(existsSync(stagingProfile)).toBe(false)
    expect(existsSync(manager.paths.pending)).toBe(false)
  })

  it('holds the transaction lock until the pnpm worker exits', async () => {
    const { root, manager } = setup()
    await manager.applyRelease('1.0.0', hooks())
    const ready = join(root, 'ready')
    const release = join(root, 'release')
    const blocker = join(root, 'blocking.mjs')
    writeFileSync(blocker, `import {existsSync, writeFileSync} from 'node:fs'; import {setTimeout as sleep} from 'node:timers/promises'; writeFileSync(${JSON.stringify(ready)}, String(process.pid)); while (!existsSync(${JSON.stringify(release)})) await sleep(10); await import(${JSON.stringify(pathToFileURL(manager.runtime.pnpm).href)})`)
    const worker = new DesktopProjectManager(manager.paths, { ...manager.runtime, pnpm: blocker })
    await worker.applyRelease('1.0.0', hooks())
    const pending = worker.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks())
    try {
      await expect.poll(() => existsSync(ready)).toBe(true)
      expect(readFileSync(manager.paths.lock, 'utf8').trim()).toBe(readFileSync(ready, 'utf8'))
      await expect(manager.applyRelease('1.0.0', hooks())).rejects.toThrow(/another package transaction/u)
    } finally {
      writeFileSync(release, 'continue')
      await pending
    }
    expect(existsSync(manager.paths.lock)).toBe(false)
  })
})
