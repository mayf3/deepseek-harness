/**
 * `dsh plugin add` and `remove` through the shared installer: a temporary
 * harness home, a fake pnpm that stages packages and edits the manifest the
 * way the real one does, and a fake probe. Nothing boots.
 */

import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readProfileManifest, resolveProfileDir, type probePackage } from '@deepseek-ai/dsh-app-boot'
import type { SpawnLike } from '@deepseek-ai/dsh-plugin-manager'
import { runPlugin } from '../src/plugin.ts'

let home: string
let previousHome: string | undefined
let stderr: string
let stdout: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-plugin-command-'))
  previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  stderr = ''
  stdout = ''
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { stderr += String(chunk); return true })
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { stdout += String(chunk); return true })
})

afterEach(() => {
  vi.restoreAllMocks()
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})

/** Stage one package under the profile's node_modules and record it as a dependency, as `pnpm add` does. */
function install(profileDir: string, name: string, bundle: boolean): void {
  const dir = join(profileDir, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name, version: '1.0.0', type: 'module',
    ...bundle ? { dsh: { bundle: { patch: './cordis.patch.yml' } } } : {},
  }))
  if (bundle) writeFileSync(join(dir, 'cordis.patch.yml'), '- insert:\n    - id: hello\n      name: cordis:good\n')
  const path = join(profileDir, 'package.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { dependencies?: Record<string, string> }
  writeFileSync(path, JSON.stringify({ ...manifest, dependencies: { ...manifest.dependencies, [name]: '1.0.0' } }, null, 2))
}

/** Forget one package, as `pnpm remove` does. */
function uninstall(profileDir: string, name: string): void {
  const path = join(profileDir, 'package.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { dependencies?: Record<string, string> }
  const { [name]: _gone, ...remaining } = manifest.dependencies ?? {}
  writeFileSync(path, JSON.stringify({ ...manifest, dependencies: remaining }, null, 2))
  rmSync(join(profileDir, 'node_modules', name), { recursive: true, force: true })
}

/** A pnpm that installs `ext-bundle` as a bundle and everything else as a plain library, or fails as told. */
function fakePnpm(calls: string[][], failWith?: { code: number } | { error: NodeJS.ErrnoException }): SpawnLike {
  return (_command, args, options) => {
    calls.push([...args])
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    setTimeout(() => {
      if (failWith !== undefined && 'error' in failWith) {
        child.emit('error', failWith.error)
        return
      }
      if (failWith !== undefined) {
        child.stderr.write('ERR_PNPM_FETCH\n')
        child.emit('close', failWith.code)
        return
      }
      const [verb, target] = args
      const profileDir = options.cwd as string
      if (verb === 'add' && target !== undefined) install(profileDir, target, target === 'ext-bundle')
      if (verb === 'remove' && target !== undefined) uninstall(profileDir, target)
      child.stdout.write(`${verb === 'add' ? '+' : '-'} ${String(target)}\n`)
      child.emit('close', 0)
    }, 5)
    return child as unknown as ChildProcess
  }
}

/** A probe that reads the staged manifest: a package with `dsh.bundle` is a bundle, anything else a library. */
const fakeProbe: typeof probePackage = (options) => {
  const manifest = JSON.parse(readFileSync(join(options.profileDir, 'node_modules', options.packageName, 'package.json'), 'utf8')) as { dsh?: { bundle?: unknown } }
  return Promise.resolve({
    packageName: options.packageName,
    kind: manifest.dsh?.bundle === undefined ? 'library' : 'bundle',
    ok: true,
    cordisSameCopy: null,
    rows: [],
    overrides: [],
    addable: [],
    checkedAt: new Date().toISOString(),
  })
}

describe('dsh plugin', () => {
  it('add initializes the profile, installs through the installer, enables the new bundle, and removes a plain library again', async () => {
    const calls: string[][] = []

    const code = await runPlugin('web', ['add', 'ext-bundle', 'ext-lib'], { spawn: fakePnpm(calls), probe: fakeProbe })

    expect(code).toBe(0)
    const profileDir = resolveProfileDir('web', home)
    expect(stderr).toContain(`dsh: initialized profile web at ${profileDir}`)
    expect(calls).toEqual([['add', 'ext-bundle'], ['add', 'ext-lib'], ['remove', 'ext-lib']])
    const manifest = readProfileManifest('dsh', profileDir)
    expect(Object.keys(manifest.dependencies ?? {})).toContain('ext-bundle')
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain('ext-lib')
    expect(manifest.dsh?.profile?.bundles).toContain('ext-bundle')
    expect(stdout).toContain('+ ext-bundle')
    expect(stderr).toContain('dsh: removed ext-lib again: declares neither a dsh bundle nor a plugin module')
    expect(existsSync(join(profileDir, '.dsh-plugins', 'ext-bundle.json'))).toBe(true)
  })

  it('remove goes through the installer and forgets the probe record', async () => {
    const calls: string[][] = []
    await runPlugin('web', ['add', 'ext-bundle'], { spawn: fakePnpm(calls), probe: fakeProbe })

    const code = await runPlugin('web', ['remove', 'ext-bundle'], { spawn: fakePnpm(calls), probe: fakeProbe })

    expect(code).toBe(0)
    expect(calls).toEqual([['add', 'ext-bundle'], ['remove', 'ext-bundle']])
    const profileDir = resolveProfileDir('web', home)
    const manifest = readProfileManifest('dsh', profileDir)
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain('ext-bundle')
    expect(manifest.dsh?.profile?.bundles).not.toContain('ext-bundle')
    expect(existsSync(join(profileDir, '.dsh-plugins', 'ext-bundle.json'))).toBe(false)
  })

  it('reports a failed pnpm run with its exit code, the git hint, and a missing pnpm as 127', async () => {
    const failed = await runPlugin('web', ['add', 'github:acme/plugin'], { spawn: fakePnpm([], { code: 1 }), probe: fakeProbe })
    expect(failed).toBe(1)
    expect(stderr).toContain('dsh: pnpm failed in profile directory')
    expect(stderr).toContain('git-hosted plugins build on install via their prepare script')

    const error = Object.assign(new Error('spawn pnpm ENOENT'), { code: 'ENOENT' })
    const missing = await runPlugin('web', ['add', 'ext-bundle'], { spawn: fakePnpm([], { error }), probe: fakeProbe })
    expect(missing).toBe(127)
    expect(stderr).toContain('dsh: pnpm not found on PATH')
  })
})
