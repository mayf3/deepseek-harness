/**
 * External bundle composition (one contained group per bundle, ids as
 * declared) and the manifest operations behind installing, enabling, and
 * disabling.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import {
  bundleGroupId, bundleLayerPatches, composeExternalLayer, CONTAINED_GROUP_MODULE, disableBundle, enableBundle,
  exportsBundlePatch, isContainedLayer, isJsDisabled, reconcileInstalledBundles, readProfileManifest, type ProfileLayer,
} from '../src/index.ts'

const NAME = 'dsh-test-bin'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'dsh-external-bundles-'))

function layer(packageName: string, patches: PatchOptions[]): ProfileLayer {
  return {
    packageName, version: '1.0.0', packageDir: '/nowhere', patchPath: '/nowhere/cordis.patch.yml',
    trust: 'external', stage: 'runtime', patches,
  }
}

describe('composeExternalLayer', () => {
  it('wraps root inserts in one contained group and keeps every row id as declared', () => {
    const composed = composeExternalLayer(layer('pkg-a', [
      { insert: [{ id: 'tool', name: 'pkg-a' }, { name: 'pkg-a/anonymous' } as EntryOptions] },
      { insert: [{ id: 'grp', name: 'cordis:group', group: true, config: [{ id: 'inner', name: 'pkg-a/inner' }] }] },
    ]))
    expect(composed.patches).toEqual([{
      insert: [{
        id: 'bundle/pkg-a',
        name: CONTAINED_GROUP_MODULE,
        group: true,
        config: [
          { id: 'tool', name: 'pkg-a' },
          { name: 'pkg-a/anonymous' },
          { id: 'grp', name: 'cordis:group', group: true, config: [{ id: 'inner', name: 'pkg-a/inner' }] },
        ],
      }],
    }])
    expect([...composed.rows]).toEqual([
      ['tool', 'pkg-a'], ['grp', 'cordis:group'], ['inner', 'pkg-a/inner'], ['bundle/pkg-a', CONTAINED_GROUP_MODULE],
    ])
    expect(composed.overrides).toEqual([])
  })

  it('passes patches on the bundle\'s own rows through and reports patches on other rows as overrides', () => {
    const composed = composeExternalLayer(layer('pkg-b', [
      { insert: [{ id: 'own', name: 'pkg-b' }] },
      { id: 'own', config: { flag: true } },
      { id: 'settings', config: { path: '/x' } },
      { id: 'own', insert: [{ id: 'child', name: 'pkg-b/child' }] },
    ]))
    expect(composed.patches.slice(1)).toEqual([
      { id: 'own', insert: [{ id: 'child', name: 'pkg-b/child' }] },
      { id: 'own', config: { flag: true } },
      { id: 'settings', config: { path: '/x' } },
    ])
    expect(composed.overrides).toEqual(['settings'])
  })

  it('nests rows inserted into a built-in group inside their own contained group', () => {
    const composed = composeExternalLayer(layer('pkg-c', [
      { id: 'persistent-shell', insert: [{ id: 'extra', name: 'pkg-c/extra' }] },
    ]))
    expect(composed.patches).toEqual([
      { insert: [{ id: 'bundle/pkg-c', name: CONTAINED_GROUP_MODULE, group: true, config: [] }] },
      {
        id: 'persistent-shell',
        insert: [{ id: 'bundle/pkg-c/in/persistent-shell', name: CONTAINED_GROUP_MODULE, group: true, config: [{ id: 'extra', name: 'pkg-c/extra' }] }],
      },
    ])
    expect(composed.rows.get('bundle/pkg-c/in/persistent-shell')).toBe(CONTAINED_GROUP_MODULE)
  })

  it('never mutates the layer\'s own patch objects', () => {
    const patches: PatchOptions[] = [{ insert: [{ id: 'row', name: 'pkg-d' }] }, { id: 'row', config: { a: 1 } }]
    const snapshot = structuredClone(patches)
    composeExternalLayer(layer('pkg-d', patches))
    expect(patches).toEqual(snapshot)
  })

  it('spells the group id without the Loader\'s nested-id separator', () => {
    expect(bundleGroupId('@scope/pkg')).toBe('bundle/@scope/pkg')
    expect(bundleGroupId('x')).not.toContain(':')
  })

  it('mounts only runtime-staged external layers as contained groups', () => {
    const contained = layer('pkg-e', [{ insert: [{ id: 'row', name: 'pkg-e' }] }])
    const booted: ProfileLayer = { ...contained, stage: 'boot' }
    const builtin: ProfileLayer = { ...contained, trust: 'builtin' }
    expect(isContainedLayer(contained)).toBe(true)
    expect(bundleLayerPatches(contained)[0]?.insert?.[0]?.id).toBe('bundle/pkg-e')
    for (const plain of [booted, builtin]) {
      expect(isContainedLayer(plain)).toBe(false)
      expect(bundleLayerPatches(plain)).toBe(plain.patches)
    }
  })

  it('tells a !!js disabled node from a literal', () => {
    expect(isJsDisabled({ __jsExpr: 'true' })).toBe(true)
    expect(isJsDisabled(true)).toBe(false)
  })
})

/** Stage a profile directory whose node_modules holds the named packages. */
function stageProfile(packages: Record<string, { bundle?: boolean; dependency?: boolean }>): { profileDir: string; installAnchor: string } {
  const root = tmp()
  const appDir = join(root, 'app')
  mkdirSync(join(appDir, 'node_modules'), { recursive: true })
  writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: 'dsh-app', version: '0.0.0' }))
  const profileDir = join(root, 'profile')
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  const dependencies: Record<string, string> = {}
  for (const [name, spec] of Object.entries(packages)) {
    const dir = join(profileDir, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name, version: '1.2.3', ...spec.bundle === true ? { dsh: { bundle: { patch: './cordis.patch.yml' } } } : {},
    }))
    if (spec.bundle === true) writeFileSync(join(dir, 'cordis.patch.yml'), `- insert:\n    - id: row\n      name: ${name}\n`)
    if (spec.dependency !== false) dependencies[name] = '1.2.3'
  }
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-test', private: true, dependencies, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }))
  return { profileDir, installAnchor: join(appDir, 'package.json') }
}

describe('reconcileInstalledBundles', () => {
  it('tells bundles from plain packages and enables new bundles only when asked', () => {
    const { profileDir, installAnchor } = stageProfile({ 'ext-bundle': { bundle: true }, 'plain-lib': {} })
    const before = { dependencies: {} }

    const installedOnly = reconcileInstalledBundles(NAME, profileDir, installAnchor, before, { autoEnable: false })
    expect(installedOnly).toEqual({ enabled: [], removed: [], plain: ['plain-lib'], installedOnly: ['ext-bundle'] })
    expect(readProfileManifest(NAME, profileDir).dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base'])

    const enabled = reconcileInstalledBundles(NAME, profileDir, installAnchor, before, { autoEnable: true })
    expect(enabled).toEqual({ enabled: ['ext-bundle'], removed: [], plain: ['plain-lib'], installedOnly: [] })
    expect(readProfileManifest(NAME, profileDir).dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base', 'ext-bundle'])
    expect(exportsBundlePatch(NAME, 'plain-lib', installAnchor, profileDir)).toBe(false)
    expect(exportsBundlePatch(NAME, 'missing', installAnchor, profileDir)).toBe(false)
  })

  it('drops a layer whose dependency was removed and keeps template bundles', () => {
    const { profileDir, installAnchor } = stageProfile({ 'ext-bundle': { bundle: true } })
    enableBundle(NAME, profileDir, installAnchor, 'ext-bundle')
    const manifest = readProfileManifest(NAME, profileDir)
    // pnpm removed the dependency; the layer list still names it.
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ ...manifest, dependencies: {} }))

    const outcome = reconcileInstalledBundles(NAME, profileDir, installAnchor, manifest, { autoEnable: true })
    expect(outcome.removed).toEqual(['ext-bundle'])
    expect(readProfileManifest(NAME, profileDir).dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base'])
  })
})

describe('reconcileInstalledBundles on a minimal manifest', () => {
  it('tolerates manifests without dependencies or a bundle list and skips already-known plain packages', () => {
    const { profileDir, installAnchor } = stageProfile({ 'plain-lib': {}, 'ext-bundle': { bundle: true } })
    const manifest = readProfileManifest(NAME, profileDir)
    // No dsh section and no bundle list at all: the layer list starts empty.
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'bare', dependencies: manifest.dependencies }))
    const outcome = reconcileInstalledBundles(NAME, profileDir, installAnchor, { dependencies: { 'plain-lib': '1.2.3' } }, { autoEnable: true })
    expect(outcome).toEqual({ enabled: ['ext-bundle'], removed: [], plain: [], installedOnly: [] })
    expect(readProfileManifest(NAME, profileDir).dsh?.profile?.bundles).toEqual(['ext-bundle'])
    // A manifest with neither section reconciles to nothing.
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'empty' }))
    expect(reconcileInstalledBundles(NAME, profileDir, installAnchor, {}, { autoEnable: true }))
      .toEqual({ enabled: [], removed: [], plain: [], installedOnly: [] })
  })

  it('enables and disables against a manifest that never had a bundle list', () => {
    const { profileDir, installAnchor } = stageProfile({ 'ext-bundle': { bundle: true } })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'bare', dependencies: { 'ext-bundle': '1.2.3' } }))
    expect(disableBundle(NAME, profileDir, 'ext-bundle')).toBe(false)
    expect(enableBundle(NAME, profileDir, installAnchor, 'ext-bundle')).toBe(true)
    expect(readProfileManifest(NAME, profileDir).dsh?.profile?.bundles).toEqual(['ext-bundle'])
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'bare', dsh: { profile: { bundles: ['ext-bundle'] } } }))
    expect(() => disableBundle(NAME, profileDir, 'ext-bundle')).toThrow(/template bundle/)
    expect(() => enableBundle(NAME, profileDir, installAnchor, 'ext-bundle')).toThrow(/is not installed/)
  })
})

describe('enableBundle / disableBundle', () => {
  it('appends and removes dependency-managed bundles, reporting no-ops', () => {
    const { profileDir, installAnchor } = stageProfile({ 'ext-bundle': { bundle: true } })
    expect(enableBundle(NAME, profileDir, installAnchor, 'ext-bundle')).toBe(true)
    expect(enableBundle(NAME, profileDir, installAnchor, 'ext-bundle')).toBe(false)
    expect(readProfileManifest(NAME, profileDir).dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base', 'ext-bundle'])
    expect(disableBundle(NAME, profileDir, 'ext-bundle')).toBe(true)
    expect(disableBundle(NAME, profileDir, 'ext-bundle')).toBe(false)
    expect(readProfileManifest(NAME, profileDir).dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base'])
  })

  it('refuses a package that is not installed, not a bundle, or a template bundle', () => {
    const { profileDir, installAnchor } = stageProfile({ 'plain-lib': {} })
    expect(() => enableBundle(NAME, profileDir, installAnchor, 'ghost')).toThrow(/is not installed in profile/)
    expect(() => enableBundle(NAME, profileDir, installAnchor, 'plain-lib')).toThrow(/declares no dsh\.bundle/)
    expect(() => disableBundle(NAME, profileDir, '@deepseek-ai/dsh-base')).toThrow(/template bundle/)
  })
})
