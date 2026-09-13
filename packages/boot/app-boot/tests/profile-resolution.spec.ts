/** Runtime profile resolution uses one eager generation for ESM and CommonJS. */

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getEnvironmentData } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import {
  installProfileResolution,
  registerWorkerResolution,
  type ProfileResolutionRegistration,
} from '../src/profile-resolution/resolver.ts'
import {
  createProfileResolutionGeneration,
  healProfilesModuleFallback,
  type Profile,
  type ProfileResolutionGeneration,
} from '../src/profile.ts'

const roots: string[] = []
const registrations: ProfileResolutionRegistration[] = []

afterEach(() => {
  for (const registration of registrations.splice(0).reverse()) registration.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function file(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

function pkg(
  dir: string,
  name: string,
  marker: number,
  dependencies: Record<string, string> = {},
  peerDependencies: Record<string, string> = {},
): string {
  file(join(dir, 'package.json'), JSON.stringify({
    name,
    version: `${String(marker)}.0.0`,
    type: 'module',
    exports: { import: './index.js', require: './index.cjs' },
    dependencies,
    peerDependencies,
  }))
  file(join(dir, 'index.js'), `export const marker = ${String(marker)}\n`)
  file(join(dir, 'index.cjs'), `module.exports = { marker: ${String(marker)} }\n`)
  return join(dir, 'package.json')
}

function conditionalPkg(dir: string, name: string, importMarker: number, requireMarker: number): string {
  file(join(dir, 'package.json'), JSON.stringify({
    name,
    version: '1.0.0',
    type: 'module',
    exports: { custom: './custom.cjs', import: './import.js', require: './require.cjs' },
  }))
  file(join(dir, 'import.js'), `export const marker = ${String(importMarker)}\n`)
  file(join(dir, 'require.cjs'), `module.exports = { marker: ${String(requireMarker)} }\n`)
  file(join(dir, 'custom.cjs'), 'module.exports = { marker: 13 }\n')
  return join(dir, 'package.json')
}

async function importFrom(specifier: string, parent: string): Promise<Record<string, unknown>> {
  const addon = createRequire(import.meta.url)('node-addon-require-builtin') as {
    requireBuiltin(id: string): unknown
  }
  const loader = addon.requireBuiltin('internal/modules/esm/loader') as {
    getOrInitializeCascadedLoader(): {
      import(specifier: string, parent: string, attributes: ImportAttributes): Promise<Record<string, unknown>>
    }
  }
  return await loader.getOrInitializeCascadedLoader().import(specifier, parent, {})
}

function resolveFrom(
  specifier: string, parent: string | undefined, attributes: ImportAttributes = {}, skipSyncHooks = false,
): string {
  const addon = createRequire(import.meta.url)('node-addon-require-builtin') as {
    requireBuiltin(id: string): unknown
  }
  const loader = addon.requireBuiltin('internal/modules/esm/loader') as {
    getOrInitializeCascadedLoader(): {
      getOrCreateModuleJob?: unknown
      resolveSync(
        first: string | undefined,
        second: string | undefined | { specifier: string; attributes: ImportAttributes },
        third?: ImportAttributes | boolean,
      ): { url: string }
    }
  }
  const internal = loader.getOrInitializeCascadedLoader()
  if (!('getOrCreateModuleJob' in internal)) return internal.resolveSync(specifier, parent, attributes).url
  return skipSyncHooks
    ? internal.resolveSync(parent, { specifier, attributes }, true).url
    : internal.resolveSync(parent, { specifier, attributes }).url
}

function fixture(name = 'resolution-lib'): {
  root: string
  installAnchor: string
  installed: string
  profile: Profile
} {
  // macOS exposes tmpdir through /var while Node returns resolved module paths through /private/var.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-profile-generation-')))
  roots.push(root)
  const installDir = join(root, 'install')
  const installed = join(installDir, 'node_modules', name)
  const installAnchor = pkg(installDir, 'test-app', 0, { [name]: '*' })
  pkg(installed, name, 1)
  const profileDir = join(root, 'profiles', 'test')
  file(join(profileDir, 'package.json'), JSON.stringify({
    name: 'test-profile', private: true, dependencies: { 'missing-local': '*' },
  }))
  return {
    root,
    installAnchor,
    installed,
    profile: {
      name: 'test',
      dir: profileDir,
      layers: [],
      patchPath: join(profileDir, 'cordis.patch.yml'),
      patches: [],
      patchReload: 'startup',
    },
  }
}

async function generationOf(f: ReturnType<typeof fixture>): Promise<ProfileResolutionGeneration> {
  return await healProfilesModuleFallback({
    installAnchor: f.installAnchor,
    profile: f.profile,
    home: f.root,
    materialize: false,
  })
}

describe('profile resolution generation', { concurrent: false }, () => {
  it('computes the old fallback graph without materializing it', async () => {
    const f = fixture()
    const generation = await generationOf(f)
    expect(generation.entries.find(entry => entry.name === 'resolution-lib')).toMatchObject({
      packageDir: f.installed,
      version: '1.0.0',
      declarer: f.installAnchor,
      scope: 'installation',
    })
    expect(existsSync(join(generation.profilesDir, 'node_modules'))).toBe(false)
    expect(existsSync(join(f.profile.dir, '.dsh-module-fallback'))).toBe(false)
    expect(Object.isFrozen(generation)).toBe(true)
    expect(Object.isFrozen(generation.entries)).toBe(true)
    expect(generation.entries.every(Object.isFrozen)).toBe(true)

    const installationOnly = await createProfileResolutionGeneration({
      installAnchor: f.installAnchor,
      home: join(f.root, 'installation-only-home'),
    })
    expect(installationOnly.profileDir).toBeUndefined()
    expect(installationOnly.localPackageNames).toEqual([])
    const registration = installProfileResolution(installationOnly)
    registrations.push(registration)
    expect(createRequire(join(installationOnly.profilesDir, 'entry.cjs'))('resolution-lib'))
      .toEqual({ marker: 1 })
  })

  it('fails generation construction before writing when the profile manifest is malformed', async () => {
    const f = fixture()
    file(join(f.profile.dir, 'package.json'), '{')
    await expect(generationOf(f)).rejects.toThrow(SyntaxError)
    expect(existsSync(join(f.root, 'profiles', 'node_modules'))).toBe(false)
  })

  it('materializes exactly the package targets in the computed generation', async () => {
    const f = fixture()
    const computed = await generationOf(f)
    const materialized = await healProfilesModuleFallback({
      installAnchor: f.installAnchor,
      profile: f.profile,
      home: f.root,
    })
    expect(materialized).toEqual(computed)
    for (const entry of computed.entries) {
      const projected = entry.scope === 'installation'
        ? join(computed.profilesDir, 'node_modules', entry.name)
        : join(f.profile.dir, '.dsh-module-fallback', 'node_modules', entry.name)
      expect(realpathSync(projected)).toBe(realpathSync(entry.packageDir))
    }
  })

  it('keeps each earlier root complete before considering a later root', async () => {
    const f = fixture('installation-bridge')
    const installedBridge = f.installed
    const installationChoice = join(installedBridge, 'node_modules', 'ordered-choice')
    pkg(installedBridge, 'installation-bridge', 1, { 'ordered-choice': '*' }, { 'peer-choice': '*' })
    pkg(installationChoice, 'ordered-choice', 1)
    const peerChoice = join(installedBridge, 'node_modules', 'peer-choice')
    pkg(peerChoice, 'peer-choice', 3)
    const bundleDir = join(f.root, 'bundle')
    pkg(bundleDir, 'test-bundle', 0, { 'ordered-choice': '*', 'bundle-bridge': '*' })
    pkg(join(bundleDir, 'node_modules', 'ordered-choice'), 'ordered-choice', 2)
    const bundleBridge = join(bundleDir, 'node_modules', 'bundle-bridge')
    pkg(bundleBridge, 'bundle-bridge', 0, { 'bundle-choice': '*' })
    const firstBundleChoice = join(bundleBridge, 'node_modules', 'bundle-choice')
    pkg(firstBundleChoice, 'bundle-choice', 1)
    const laterBundle = join(f.root, 'later-bundle')
    pkg(laterBundle, 'later-bundle', 0, { 'bundle-choice': '*' })
    pkg(join(laterBundle, 'node_modules', 'bundle-choice'), 'bundle-choice', 2)
    f.profile.layers.push({
      packageName: 'test-bundle',
      packageDir: bundleDir,
      patchPath: join(bundleDir, 'cordis.patch.yml'),
      patches: [],
    }, {
      packageName: 'later-bundle',
      packageDir: laterBundle,
      patchPath: join(laterBundle, 'cordis.patch.yml'),
      patches: [],
    })

    const generation = await generationOf(f)
    expect(generation.entries.find(entry => entry.name === 'ordered-choice')).toMatchObject({
      packageDir: installationChoice,
      scope: 'installation',
    })
    const bundleChoice = generation.entries.find(entry => entry.name === 'bundle-choice')
    if (bundleChoice === undefined) throw new Error('generation omitted bundle-choice')
    expect(bundleChoice).toMatchObject({ scope: 'profile' })
    expect(realpathSync(bundleChoice.packageDir)).toBe(realpathSync(firstBundleChoice))
    expect(generation.entries.find(entry => entry.name === 'peer-choice')).toMatchObject({
      packageDir: peerChoice,
      scope: 'installation',
    })
  })

  it('routes ESM and CommonJS through the same installation entry', async () => {
    const f = fixture()
    const registration = installProfileResolution(await generationOf(f))
    registrations.push(registration)
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    expect(require('resolution-lib')).toEqual({ marker: 1 })
    expect(require.resolve('resolution-lib')).toBe(join(f.installed, 'index.cjs'))
    const parent = pathToFileURL(join(f.profile.dir, 'entry.mjs')).href
    expect(resolveFrom('resolution-lib', parent)).toBe(pathToFileURL(join(f.installed, 'index.js')).href)
    expect(resolveFrom('resolution-lib', parent)).toBe(pathToFileURL(join(f.installed, 'index.js')).href)
    expect(import.meta.resolve('resolution-lib', parent)).toBe(pathToFileURL(join(f.installed, 'index.js')).href)
    expect(await importFrom('resolution-lib', parent)).toMatchObject({ marker: 1 })
  })

  it('routes an application-owned profile outside the shared profiles directory', async () => {
    const f = fixture()
    const profileDir = join(f.root, 'application-profile')
    file(join(profileDir, 'package.json'), JSON.stringify({ name: 'application-profile', private: true }))
    const profile = {
      ...f.profile,
      dir: profileDir,
      patchPath: join(profileDir, 'cordis.patch.yml'),
    }
    const generation = await healProfilesModuleFallback({
      installAnchor: f.installAnchor,
      profile,
      home: f.root,
      materialize: false,
    })
    const registration = installProfileResolution(generation)
    registrations.push(registration)
    const require = createRequire(join(profileDir, 'entry.cjs'))
    expect(require('resolution-lib')).toEqual({ marker: 1 })
    const parent = pathToFileURL(join(profileDir, 'entry.mjs')).href
    expect(resolveFrom('resolution-lib', parent)).toBe(pathToFileURL(join(f.installed, 'index.js')).href)
    expect(await importFrom('resolution-lib', parent)).toMatchObject({ marker: 1 })
    expect(() => { createRequire(join(f.root, 'outside.cjs'))('resolution-lib') }).toThrow(/Cannot find module/u)
  })

  it('does not reuse a default route for explicit CommonJS paths', async () => {
    const f = fixture()
    const alternative = join(f.root, 'alternative')
    const alternativePackage = join(alternative, 'node_modules', 'resolution-lib')
    pkg(alternativePackage, 'resolution-lib', 2)
    const registration = installProfileResolution(await generationOf(f))
    registrations.push(registration)
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    expect(require.resolve('resolution-lib')).toBe(join(f.installed, 'index.cjs'))
    expect(require.resolve('resolution-lib', { paths: [alternative] })).toBe(join(alternativePackage, 'index.cjs'))
    expect(require.resolve('resolution-lib', { paths: [f.profile.dir] })).toBe(join(f.installed, 'index.cjs'))
    expect(require.resolve('resolution-lib', { paths: [join(f.root, 'missing'), f.profile.dir] }))
      .toBe(join(f.installed, 'index.cjs'))
    const invalid = join(f.root, 'invalid')
    file(join(invalid, 'node_modules', 'resolution-lib', 'package.json'), '{')
    expect(() => { require.resolve('resolution-lib', { paths: [invalid, f.profile.dir] }) })
      .toThrow(/Invalid package config/u)
  })

  it('keeps a profile-local package ahead of the generation', async () => {
    const f = fixture()
    file(join(f.profile.dir, 'package.json'), JSON.stringify({
      name: 'test-profile',
      private: true,
      dependencies: { 'resolution-lib': '*', 'linked-local': '*' },
    }))
    const localResolution = join(f.profile.dir, 'node_modules', 'resolution-lib')
    pkg(localResolution, 'resolution-lib', 2)
    const linkedLocal = join(f.root, 'linked-local')
    pkg(linkedLocal, 'linked-local', 3)
    symlinkSync(
      linkedLocal,
      join(f.profile.dir, 'node_modules', 'linked-local'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    const generation = await generationOf(f)
    expect(generation.localPackageNames).toEqual(['resolution-lib', 'linked-local'])
    const registration = installProfileResolution(generation)
    registrations.push(registration)
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    expect(require('resolution-lib')).toEqual({ marker: 2 })
    expect(require.resolve('resolution-lib', { paths: [f.profile.dir] }))
      .toBe(join(localResolution, 'index.cjs'))
    const parent = pathToFileURL(join(f.profile.dir, 'entry.mjs')).href
    expect(resolveFrom('resolution-lib', parent)).toBe(
      pathToFileURL(join(f.profile.dir, 'node_modules', 'resolution-lib', 'index.js')).href,
    )
  })

  it('preserves an npm alias package self-reference', async () => {
    const f = fixture()
    file(join(f.profile.dir, 'package.json'), JSON.stringify({
      name: 'test-profile',
      private: true,
      dependencies: { alias: 'npm:real-name' },
    }))
    const alias = join(f.profile.dir, 'node_modules', 'alias')
    pkg(alias, 'real-name', 6)
    const generation = await generationOf(f)
    expect(generation.localPackageNames).toEqual(['alias'])
    const registration = installProfileResolution(generation)
    registrations.push(registration)

    const require = createRequire(join(alias, 'inside.cjs'))
    expect(require.resolve('real-name')).toBe(join(alias, 'index.cjs'))
    expect(resolveFrom('real-name', pathToFileURL(join(alias, 'inside.mjs')).href)).toBe(
      pathToFileURL(join(alias, 'index.js')).href,
    )
    const invalidScope = join(f.profile.dir, 'node_modules', 'invalid-scope')
    file(join(invalidScope, 'package.json'), '{')
    expect(createRequire(join(invalidScope, 'inside.cjs')).resolve('resolution-lib'))
      .toBe(join(f.installed, 'index.cjs'))
    expect(() => resolveFrom('resolution-lib', pathToFileURL(join(invalidScope, 'inside.mjs')).href))
      .toThrow(/Invalid package config/u)
  })

  it('falls through a missing local CommonJS subpath to the generation', async () => {
    const f = fixture()
    file(join(f.profile.dir, 'package.json'), JSON.stringify({
      name: 'test-profile',
      private: true,
      dependencies: { 'resolution-lib': '*' },
    }))
    file(join(f.installed, 'package.json'), JSON.stringify({
      name: 'resolution-lib', version: '1.0.0', type: 'module', main: './index.cjs',
    }))
    file(join(f.installed, 'only-install.cjs'), 'module.exports = { marker: 8 }\n')
    file(join(f.installed, 'legacy-install.cjs'), 'module.exports = { marker: 9 }\n')
    const local = join(f.profile.dir, 'node_modules', 'resolution-lib')
    file(join(local, 'package.json'), JSON.stringify({
      name: 'resolution-lib', version: '2.0.0', type: 'module', main: './index.cjs',
    }))
    file(join(local, 'index.cjs'), 'module.exports = { marker: 2 }\n')
    const generation = await generationOf(f)
    expect(generation.localPackageNames).toEqual(['resolution-lib'])
    const registration = installProfileResolution(generation)
    registrations.push(registration)

    expect(createRequire(join(f.profile.dir, 'entry.cjs')).resolve('resolution-lib/only-install.cjs'))
      .toBe(join(f.installed, 'only-install.cjs'))
    rmSync(join(local, 'package.json'))
    expect(createRequire(join(f.profile.dir, 'entry.cjs')).resolve('resolution-lib/legacy-install.cjs'))
      .toBe(join(f.installed, 'legacy-install.cjs'))
  })

  it('observes a profile-local package installed after an earlier miss', async () => {
    const f = fixture()
    const registration = installProfileResolution(await generationOf(f))
    registrations.push(registration)
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    const parent = pathToFileURL(join(f.profile.dir, 'entry.mjs')).href
    expect(() => { require.resolve('missing-local') }).toThrow(/Cannot find module/u)
    expect(() => resolveFrom('missing-local', parent)).toThrow(/Cannot find/u)
    file(join(f.profile.dir, 'node_modules', 'legacy-missing', 'index.js'), 'module.exports = {}\n')
    expect(() => { require.resolve('legacy-missing/subpath') }).toThrow(/Cannot find module/u)

    const local = join(f.profile.dir, 'node_modules', 'missing-local')
    pkg(local, 'missing-local', 7)
    expect(require.resolve('missing-local')).toBe(join(local, 'index.cjs'))
    expect(resolveFrom('missing-local', parent)).toBe(pathToFileURL(join(local, 'index.js')).href)
  })

  it('delegates undeclared local packages and non-package specifiers to Node', async () => {
    const f = fixture()
    pkg(join(f.profile.dir, 'node_modules', 'undeclared-local'), 'undeclared-local', 6)
    file(join(f.profile.dir, 'relative.cjs'), 'module.exports = 7\n')
    const registration = installProfileResolution(await generationOf(f))
    registrations.push(registration)
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    expect(require('undeclared-local')).toEqual({ marker: 6 })
    expect(require('./relative.cjs')).toBe(7)
    expect(require('node:path')).toHaveProperty('join')
    expect(require('path')).toHaveProperty('join')
    const parent = pathToFileURL(join(f.profile.dir, 'undeclared-entry.mjs')).href
    expect(registration.packageDir('undeclared-local', parent))
      .toBe(join(f.profile.dir, 'node_modules', 'undeclared-local'))
    expect(registration.packageDir('undeclared-local', parent))
      .toBe(join(f.profile.dir, 'node_modules', 'undeclared-local'))
    expect(resolveFrom('undeclared-local', parent)).toBe(
      pathToFileURL(join(f.profile.dir, 'node_modules', 'undeclared-local', 'index.js')).href,
    )
    expect(await importFrom('undeclared-local', parent)).toMatchObject({ marker: 6 })
    expect(resolveFrom('node:path', undefined)).toBe('node:path')
    expect(resolveFrom('fs', parent)).toBe('node:fs')
    expect(resolveFrom('node:path', pathToFileURL(join(f.root, 'outside.mjs')).href, {}, true)).toBe('node:path')

    const addon = createRequire(import.meta.url)('node-addon-require-builtin') as { requireBuiltin(id: string): unknown }
    const internal = addon.requireBuiltin('internal/modules/cjs/loader') as {
      Module: {
        _resolveFilename(
          request: string, parent: { filename?: string } | undefined, isMain: boolean,
        ): string
      }
    }
    expect(internal.Module._resolveFilename('node:path', undefined, false)).toBe('node:path')
  })

  it('keeps a legacy CommonJS package without a manifest ahead of the generation', async () => {
    const f = fixture()
    file(join(f.profile.dir, 'node_modules', 'resolution-lib', 'index.js'), 'module.exports = { marker: 2 }\n')
    const registration = installProfileResolution(await generationOf(f))
    registrations.push(registration)
    expect(createRequire(join(f.profile.dir, 'entry.cjs'))('resolution-lib')).toEqual({ marker: 2 })
  })

  it('keeps a profile-local CommonJS package file ahead of the generation', async () => {
    const f = fixture()
    file(join(f.profile.dir, 'node_modules', 'resolution-lib.js'), 'module.exports = { marker: 2 }\n')
    const registration = installProfileResolution(await generationOf(f))
    registrations.push(registration)
    expect(createRequire(join(f.profile.dir, 'entry.cjs'))('resolution-lib')).toEqual({ marker: 2 })
    expect(resolveFrom('resolution-lib', pathToFileURL(join(f.profile.dir, 'entry.mjs')).href)).toBe(
      pathToFileURL(join(f.installed, 'index.js')).href,
    )
  })

  it('preserves the ESM and CommonJS behavior of an empty local package directory', async () => {
    const f = fixture()
    mkdirSync(join(f.profile.dir, 'node_modules', 'resolution-lib'), { recursive: true })
    const registration = installProfileResolution(await generationOf(f))
    registrations.push(registration)
    expect(createRequire(join(f.profile.dir, 'entry.cjs'))('resolution-lib')).toEqual({ marker: 1 })
    expect(() => resolveFrom(
      'resolution-lib', pathToFileURL(join(f.profile.dir, 'entry.mjs')).href,
    )).toThrow(/Cannot find/u)
  })

  it('limits bundle-only entries to the active profile', async () => {
    const f = fixture()
    const bundleDir = join(f.root, 'bundle')
    pkg(bundleDir, 'test-bundle', 0, { 'bundle-only': '*' })
    const bundleOnly = join(bundleDir, 'node_modules', 'bundle-only')
    pkg(bundleOnly, 'bundle-only', 4)
    f.profile.layers.push({
      packageName: 'test-bundle',
      packageDir: bundleDir,
      patchPath: join(bundleDir, 'cordis.patch.yml'),
      patches: [],
    })
    const registration = installProfileResolution(await generationOf(f))
    registrations.push(registration)
    expect(createRequire(join(f.profile.dir, 'entry.cjs'))('bundle-only')).toEqual({ marker: 4 })
    const other = join(f.root, 'profiles', 'other', 'entry.cjs')
    expect(() => { createRequire(other)('bundle-only') }).toThrow(/Cannot find module/u)
    const resolvedBundleOnly = createRequire(other).resolve('bundle-only', {
      paths: [dirname(other), f.profile.dir],
    })
    expect(realpathSync(resolvedBundleOnly)).toBe(realpathSync(join(bundleOnly, 'index.cjs')))
    expect(() => createRequire(other).resolve('bundle-only', { paths: [dirname(other)] }))
      .toThrow(/Cannot find module/u)
    expect(() => createRequire(other).resolve('missing-explicit', { paths: [dirname(other)] }))
      .toThrow(/Cannot find module/u)
    file(join(f.root, 'node_modules', 'invalid-after-fallback', 'package.json'), '{')
    expect(() => createRequire(other).resolve('invalid-after-fallback', {
      paths: [dirname(other), f.profile.dir],
    })).toThrow(/Invalid package config/u)
    file(join(f.root, 'node_modules', 'invalid-explicit', 'package.json'), '{')
    expect(() => createRequire(other).resolve('invalid-explicit', {
      paths: [dirname(other), f.profile.dir],
    })).toThrow(/Invalid package config/u)
  })

  it('keeps the generation ahead of packages above the shared fallback position', async () => {
    const f = fixture()
    pkg(join(f.root, 'node_modules', 'resolution-lib'), 'resolution-lib', 2)
    const registration = installProfileResolution(await generationOf(f))
    registrations.push(registration)
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    expect(require('resolution-lib')).toEqual({ marker: 1 })
    expect(await importFrom('resolution-lib', pathToFileURL(join(f.profile.dir, 'entry.mjs')).href))
      .toMatchObject({ marker: 1 })
  })

  it('skips stale shared and profile-owned fallback entries when the generation misses', async () => {
    const f = fixture()
    pkg(join(f.root, 'profiles', 'node_modules', 'stale-shared'), 'stale-shared', 9)
    pkg(join(f.root, 'node_modules', 'stale-shared'), 'stale-shared', 3)
    const target = join(f.root, 'stale-private-target')
    const owned = join(f.profile.dir, '.dsh-module-fallback', 'node_modules', 'stale-private')
    const projected = join(f.profile.dir, 'node_modules', 'stale-private')
    pkg(target, 'stale-private', 9)
    mkdirSync(dirname(owned), { recursive: true })
    symlinkSync(target, owned, process.platform === 'win32' ? 'junction' : 'dir')
    mkdirSync(dirname(projected), { recursive: true })
    symlinkSync(owned, projected, process.platform === 'win32' ? 'junction' : 'dir')
    pkg(join(f.root, 'node_modules', 'stale-private'), 'stale-private', 3)
    const registration = installProfileResolution(await generationOf(f))
    registrations.push(registration)
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    for (const name of ['stale-shared', 'stale-private']) {
      expect(require(name)).toEqual({ marker: 3 })
      expect(require.resolve(name, { paths: [f.profile.dir] })).toBe(join(f.root, 'node_modules', name, 'index.cjs'))
      expect(await importFrom(name, pathToFileURL(join(f.profile.dir, `${name}.mjs`)).href))
        .toMatchObject({ marker: 3 })
    }
  })

  it('continues after a canonicalized profiles directory from the matching parent tree', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-profile-generation-symlink-')))
    roots.push(root)
    const carrier = join(root, 'carrier')
    const profilesDir = join(root, 'home', 'profiles')
    const realProfilesDir = join(carrier, 'profiles')
    const realProfileDir = join(realProfilesDir, 'test')
    mkdirSync(realProfileDir, { recursive: true })
    mkdirSync(dirname(profilesDir), { recursive: true })
    symlinkSync(realProfilesDir, profilesDir, process.platform === 'win32' ? 'junction' : 'dir')
    pkg(join(realProfilesDir, 'node_modules', 'stale-only'), 'stale-only', 9)
    pkg(join(carrier, 'node_modules', 'stale-only'), 'stale-only', 3)
    pkg(join(root, 'home', 'node_modules', 'stale-only'), 'stale-only', 4)
    const registration = installProfileResolution({
      profilesDir,
      profileDir: join(profilesDir, 'test'),
      localPackageNames: [],
      entries: [],
    })
    registrations.push(registration)
    expect(createRequire(join(realProfileDir, 'entry.cjs'))('stale-only')).toEqual({ marker: 3 })
  })

  it('leaves conditional exports to Node', async () => {
    const f = fixture('conditional-lib')
    conditionalPkg(f.installed, 'conditional-lib', 11, 12)
    const registration = installProfileResolution(await generationOf(f))
    registrations.push(registration)
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    expect(require('conditional-lib')).toEqual({ marker: 12 })
    expect(await importFrom('conditional-lib', pathToFileURL(join(f.profile.dir, 'entry.mjs')).href))
      .toMatchObject({ marker: 11 })
    const addon = createRequire(import.meta.url)('node-addon-require-builtin') as { requireBuiltin(id: string): unknown }
    const internal = addon.requireBuiltin('internal/modules/cjs/loader') as {
      Module: {
        new(id?: string): { filename?: string; paths?: string[] }
        _nodeModulePaths(path: string): string[]
        _resolveFilename(
          request: string,
          parent: { filename?: string; paths?: string[] },
          isMain: boolean,
          options: { conditions: Set<string> },
        ): string
      }
    }
    const parentFile = join(f.profile.dir, 'conditional-entry.cjs')
    const parent = new internal.Module(parentFile)
    parent.filename = parentFile
    parent.paths = internal.Module._nodeModulePaths(f.profile.dir)
    expect(internal.Module._resolveFilename(
      'conditional-lib', parent, false, { conditions: new Set(['node', 'require', 'custom']) },
    )).toBe(join(f.installed, 'custom.cjs'))
  })

  it('does not fall back after Node selects a broken profile-local package', async () => {
    const f = fixture('broken-lib')
    file(join(f.profile.dir, 'node_modules', 'broken-lib', 'package.json'), JSON.stringify({
      name: 'broken-lib',
      exports: './missing.js',
    }))
    const registration = installProfileResolution(await generationOf(f))
    registrations.push(registration)
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    expect(() => { require('broken-lib') }).toThrow(/Cannot find module|could not find/u)
    await expect(importFrom(
      'broken-lib', pathToFileURL(join(f.profile.dir, 'broken-entry.mjs')).href,
    )).rejects.toThrow(/Cannot find module|Cannot find package/u)
  })

  it('detects a dual-mode mismatch instead of accepting another package', async () => {
    const f = fixture()
    const disk = await healProfilesModuleFallback({
      installAnchor: f.installAnchor,
      profile: f.profile,
      home: f.root,
    })
    const second = join(f.root, 'second')
    pkg(second, 'resolution-lib', 2)
    const mismatched = {
      ...disk,
      entries: disk.entries.map(entry => entry.name === 'resolution-lib'
        ? { ...entry, packageDir: second, declarer: join(second, 'package.json') }
        : entry),
    }
    const registration = installProfileResolution(mismatched, 'verify')
    registrations.push(registration)
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    expect(() => { require.resolve('resolution-lib') }).toThrow(/profile resolution mismatch/u)
    await expect(importFrom(
      'resolution-lib', pathToFileURL(join(f.profile.dir, 'entry.mjs')).href,
    )).rejects.toThrow(/profile resolution mismatch/u)
  })

  it('accepts matching disk and generation targets in dual mode', async () => {
    const f = fixture()
    const generation = await healProfilesModuleFallback({
      installAnchor: f.installAnchor,
      profile: f.profile,
      home: f.root,
    })
    const registration = installProfileResolution(generation, 'verify')
    registrations.push(registration)
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    expect(require.resolve('resolution-lib')).toBe(join(f.installed, 'index.cjs'))
    expect(await importFrom('resolution-lib', pathToFileURL(join(f.profile.dir, 'entry.mjs')).href))
      .toMatchObject({ marker: 1 })
  })

  it('publishes an additive generation and replaces its miss cache atomically', async () => {
    const f = fixture()
    const added = join(f.root, 'added')
    pkg(added, 'added-lib', 2)
    const first = await generationOf(f)
    const registration = installProfileResolution(first)
    registrations.push(registration)
    const parent = pathToFileURL(join(f.profile.dir, 'entry.mjs')).href
    expect(registration.packageDir('added-lib', parent)).toBeUndefined()
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    registration.replace({
      ...first,
      entries: [...first.entries, {
        name: 'added-lib', packageDir: added, version: '2.0.0',
        declarer: join(added, 'package.json'), scope: 'installation',
      }],
    })
    expect(registration.packageDir('added-lib', parent)).toBe(added)
    expect(require.resolve('added-lib')).toBe(join(added, 'index.cjs'))
    expect(resolveFrom('added-lib', parent)).toBe(pathToFileURL(join(added, 'index.js')).href)
  })

  it('rejects changing an existing package mapping without publishing it', async () => {
    const f = fixture()
    const second = join(f.root, 'second')
    pkg(second, 'resolution-lib', 2)
    const first = await generationOf(f)
    const registration = installProfileResolution(first)
    registrations.push(registration)
    const alias = join(f.root, 'resolution-lib-alias')
    symlinkSync(f.installed, alias, process.platform === 'win32' ? 'junction' : 'dir')
    registration.replace({
      ...first,
      entries: first.entries.map(entry => entry.name === 'resolution-lib'
        ? { ...entry, packageDir: alias }
        : entry),
    })
    const changed = {
      ...first,
      entries: first.entries.map(entry => entry.name === 'resolution-lib'
        ? { ...entry, packageDir: second, version: '2.0.0', declarer: join(second, 'package.json') }
        : entry),
    }
    expect(() => { registration.replace(changed) }).toThrow(/requires a process restart/u)
    expect(() => {
      registration.replace({
        ...first,
        entries: first.entries.map(entry => entry.name === 'resolution-lib'
          ? { ...entry, version: '9.0.0' }
          : entry),
      })
    }).toThrow(/requires a process restart/u)
    expect(() => {
      registration.replace({ ...first, localPackageNames: ['resolution-lib'] })
    }).toThrow(/requires a process restart/u)
    expect(() => {
      registration.replace({ ...first, entries: first.entries.filter(entry => entry.name !== 'resolution-lib') })
    }).toThrow(/requires a process restart/u)
    expect(() => {
      registration.replace({ ...first, profilesDir: join(f.root, 'other-profiles') })
    }).toThrow(/cannot change its profile scope/u)
    registration.replace({ ...first, localPackageNames: ['new-local'] })
    registration.replace({ ...first, localPackageNames: ['new-local'] })
    expect(() => { registration.replace(first) }).toThrow(/removing local package/u)
    expect(registration.packageDir(
      'resolution-lib', pathToFileURL(join(f.profile.dir, 'entry.mjs')).href,
    )).toBe(f.installed)
  })

  it('leaves non-package and out-of-scope metadata lookups to native resolution', async () => {
    const f = fixture()
    const outside = join(f.root, 'outside')
    const outsidePackage = join(outside, 'node_modules', 'outside-lib')
    pkg(outsidePackage, 'outside-lib', 5)
    const scopedPackage = join(outside, 'node_modules', '@scope', 'outside')
    pkg(scopedPackage, '@scope/outside', 6)
    const ancestorPackage = join(f.root, 'node_modules', 'ancestor-lib')
    pkg(ancestorPackage, 'ancestor-lib', 7)
    const registration = installProfileResolution(await generationOf(f))
    registrations.push(registration)
    const profileParent = pathToFileURL(join(f.profile.dir, 'entry.mjs')).href
    const outsideParent = pathToFileURL(join(outside, 'entry.mjs')).href
    expect(registration.packageDir('', profileParent)).toBeUndefined()
    expect(registration.packageDir('./local.js', profileParent)).toBeUndefined()
    expect(registration.packageDir('/absolute.js', profileParent)).toBeUndefined()
    expect(registration.packageDir('\\server\\share', profileParent)).toBeUndefined()
    expect(registration.packageDir('#internal', profileParent)).toBeUndefined()
    expect(registration.packageDir('@scope', profileParent)).toBeUndefined()
    expect(registration.packageDir('node:fs', profileParent)).toBeUndefined()
    expect(registration.packageDir('resolution-lib/private', profileParent)).toBe(f.installed)
    expect(registration.packageDir('outside-lib', outsideParent)).toBe(outsidePackage)
    expect(registration.packageDir('outside-lib', outsideParent)).toBe(outsidePackage)
    expect(registration.packageDir('@scope/outside', outsideParent)).toBe(scopedPackage)
    expect(registration.packageDir('@scope/outside/private', outsideParent)).toBe(scopedPackage)
    expect(registration.packageDir('ancestor-lib', profileParent)).toBe(ancestorPackage)
    expect(registration.packageDir('ancestor-lib', profileParent)).toBe(ancestorPackage)
    expect(resolveFrom('outside-lib', outsideParent)).toBe(pathToFileURL(join(outsidePackage, 'index.js')).href)
    expect(resolveFrom('outside-lib', outsideParent)).toBe(pathToFileURL(join(outsidePackage, 'index.js')).href)
    expect(registration.packageDir('missing', `${pathToFileURL(f.profile.dir).href}/%ZZ`)).toBeUndefined()
  })

  it('leaves the published generation intact when successor construction fails', async () => {
    const f = fixture()
    const first = await generationOf(f)
    const registration = installProfileResolution(first)
    registrations.push(registration)
    await expect(createProfileResolutionGeneration({
      installAnchor: join(f.root, 'missing', 'package.json'),
      profile: f.profile,
      home: f.root,
    })).rejects.toThrow()
    expect(registration.packageDir(
      'resolution-lib', pathToFileURL(join(f.profile.dir, 'entry.mjs')).href,
    )).toBe(f.installed)
  })

  it('publishes and restores the generation inherited by owned Workers', async () => {
    const f = fixture()
    const generation = await generationOf(f)
    const key = '@deepseek-ai/dsh-app-boot/profile-resolution'
    const previous = getEnvironmentData(key)
    const dispose = registerWorkerResolution(generation, 'verify')
    try {
      expect(getEnvironmentData(key)).toEqual({ generation, behavior: 'verify' })
    } finally {
      dispose()
    }
    expect(getEnvironmentData(key)).toBe(previous)

    const disposeWithCache = registerWorkerResolution(generation, 'enforce', '/private/native-cache')
    try {
      expect(getEnvironmentData(key)).toEqual({
        generation, behavior: 'enforce', nativeCacheDir: '/private/native-cache',
      })
    } finally {
      disposeWithCache()
    }
    expect(getEnvironmentData(key)).toBe(previous)
  })

  it('restores CommonJS resolution when the registration is disposed', async () => {
    const f = fixture()
    const registration = installProfileResolution(await generationOf(f))
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    expect(require.resolve('resolution-lib')).toBe(join(f.installed, 'index.cjs'))
    registration.dispose()
    expect(() => { require.resolve('resolution-lib') }).toThrow(/Cannot find module/u)
  })
})
