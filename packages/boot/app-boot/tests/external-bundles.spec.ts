/** Bundle ownership analysis and installed/enabled manifest lists. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { disableBundle, enableBundle, reconcileInstalledBundles, readProfileManifest, type ProfileLayer } from '../src/index.ts'
import { analyzeBundleLayer, exportsBundlePatch } from '../src/external-bundles.ts'
const NAME = 'dsh-test-bin'
const roots: string[] = []
const tmp = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-external-bundles-'))
  roots.push(root)
  return root
}
afterEach(() => { roots.splice(0).forEach((root) => { rmSync(root, { recursive: true, force: true }) }) })
function layer(patches: PatchOptions[]): ProfileLayer {
  return { packageName: 'ext', version: undefined, packageDir: '/nowhere', patchPath: '/nowhere/patch.yml', patches }
}
describe('analyzeBundleLayer', () => {
  it('identifies declared rows across several groups without claiming override targets', () => {
    const patches: PatchOptions[] = [
      { insert: [{ id: 'own', name: 'cordis:group', group: true, config: [{ id: 'child', name: 'ext/child' }] }] },
      { id: 'tools', insert: [{ id: 'tool', name: 'ext/tool' }] },
      { id: 'ui', insert: [{ id: 'panel', name: 'ext/panel' }] },
      { id: 'webserver', config: { port: 0 } },
      { id: 'child', disabled: true },
    ]
    const result = analyzeBundleLayer(layer(patches))
    expect([...result.rows.keys()]).toEqual(['own', 'child', 'tool', 'panel'])
    expect(result.duplicates).toEqual([])
  })
  it('keeps array-valued plugin configuration out of the row inventory', () => {
    const result = analyzeBundleLayer(layer([{ id: 'provider', config: ['value', { value: 42 }, null] }]))
    expect([...result.rows]).toEqual([])
    expect(result.duplicates).toEqual([])
  })
  it('rejects repeated insert ids but permits restating children in the same group', () => {
    const patches: PatchOptions[] = [
      { insert: [{ id: 'group', name: 'cordis:group', group: true, config: [{ id: 'child', name: 'ext/child' }] }] },
      { id: 'group', config: [{ id: 'child', name: 'ext/child' }] },
      { insert: [{ id: 'child', name: 'ext/duplicate' }] },
    ]
    expect(analyzeBundleLayer(layer(patches)).duplicates).toEqual([{ rowId: 'child', moduleName: 'ext/duplicate' }])
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

  it('preserves disabled and never-enabled bundles while adding another dependency', () => {
    const { profileDir, installAnchor } = stageProfile({
      'off-bundle': { bundle: true }, 'unused-bundle': { bundle: true }, 'new-bundle': { bundle: true },
    })
    enableBundle(NAME, profileDir, installAnchor, 'off-bundle')
    disableBundle(NAME, profileDir, 'off-bundle')
    const manifest = readProfileManifest(NAME, profileDir)
    expect(manifest.dsh?.profile).toEqual({ bundles: ['@deepseek-ai/dsh-base'] })
    const before = { ...manifest, dependencies: { 'off-bundle': '1.2.3', 'unused-bundle': '1.2.3' } }

    expect(reconcileInstalledBundles(NAME, profileDir, installAnchor, before, { autoEnable: true }))
      .toEqual({ enabled: ['new-bundle'], removed: [], plain: [], installedOnly: [] })
    expect(readProfileManifest(NAME, profileDir).dsh?.profile)
      .toEqual({ bundles: ['@deepseek-ai/dsh-base', 'new-bundle'] })
    expect(enableBundle(NAME, profileDir, installAnchor, 'off-bundle')).toBe(true)
    expect(readProfileManifest(NAME, profileDir).dsh?.profile)
      .toEqual({ bundles: ['@deepseek-ai/dsh-base', 'new-bundle', 'off-bundle'] })
  })

  it('leaves an existing dependency unenabled when an update adds a bundle patch', () => {
    const { profileDir, installAnchor } = stageProfile({ 'late-bundle': {} })
    const installed = readProfileManifest(NAME, profileDir)
    const late = join(profileDir, 'node_modules', 'late-bundle')
    writeFileSync(join(late, 'package.json'), JSON.stringify({ name: 'late-bundle', version: '2.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    writeFileSync(join(late, 'cordis.patch.yml'), '[]\n')

    expect(reconcileInstalledBundles(NAME, profileDir, installAnchor, installed, { autoEnable: true }))
      .toEqual({ enabled: [], removed: [], plain: [], installedOnly: [] })
    expect(readProfileManifest(NAME, profileDir).dsh?.profile).toEqual({ bundles: ['@deepseek-ai/dsh-base'] })
  })

  it('keeps a listed bundle listed once when the run brings its dependency back', () => {
    const { profileDir, installAnchor } = stageProfile({ 'ext-bundle': { bundle: true } })
    enableBundle(NAME, profileDir, installAnchor, 'ext-bundle')
    // The manifest the run started with had lost the dependency; pnpm added it again.
    expect(reconcileInstalledBundles(NAME, profileDir, installAnchor, { dependencies: {} }, { autoEnable: true }))
      .toEqual({ enabled: [], removed: [], plain: [], installedOnly: [] })
    expect(readProfileManifest(NAME, profileDir).dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base', 'ext-bundle'])
  })

  it('drops removed dependency layers while keeping template bundles', () => {
    const { profileDir, installAnchor } = stageProfile({ 'ext-bundle': { bundle: true }, 'off-bundle': { bundle: true } })
    enableBundle(NAME, profileDir, installAnchor, 'ext-bundle')
    enableBundle(NAME, profileDir, installAnchor, 'off-bundle')
    disableBundle(NAME, profileDir, 'off-bundle')
    const manifest = readProfileManifest(NAME, profileDir)
    // pnpm removed both dependencies; the enabled layer still names ext-bundle.
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ ...manifest, dependencies: {} }))

    const outcome = reconcileInstalledBundles(NAME, profileDir, installAnchor, manifest, { autoEnable: true })
    expect(outcome.removed).toEqual(['ext-bundle'])
    expect(readProfileManifest(NAME, profileDir).dsh?.profile).toEqual({ bundles: ['@deepseek-ai/dsh-base'] })
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
