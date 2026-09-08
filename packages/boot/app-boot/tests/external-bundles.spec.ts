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
import { applyEntryPatches, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { bundleGroupId, disableBundle, enableBundle, reconcileInstalledBundles, readProfileManifest, type ProfileLayer } from '../src/index.ts'
import { composeExternalLayer, CONTAINED_GROUP_MODULE, exportsBundlePatch, isContainedLayer } from '../src/external-bundles.ts'

const NAME = 'dsh-test-bin'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'dsh-external-bundles-'))

function layer(packageName: string, patches: PatchOptions[]): ProfileLayer {
  return {
    packageName, version: '1.0.0', packageDir: '/nowhere', patchPath: '/nowhere/cordis.patch.yml',
    trust: 'external', stage: 'runtime', patches,
  }
}

describe('composeExternalLayer', () => {
  it('inserts an empty contained group first and re-targets root inserts into it, ids as declared', () => {
    const composed = composeExternalLayer(layer('pkg-a', [
      { insert: [{ id: 'tool', name: 'pkg-a' }, { name: 'pkg-a/anonymous' } as EntryOptions] },
      { insert: [{ id: 'grp', name: 'cordis:group', group: true, config: [{ id: 'inner', name: 'pkg-a/inner' }] }] },
    ]))
    expect(composed.patches).toEqual([
      { insert: [{ id: 'bundle/pkg-a', name: CONTAINED_GROUP_MODULE, group: true, config: [] }] },
      { id: 'bundle/pkg-a', insert: [{ id: 'tool', name: 'pkg-a' }, { name: 'pkg-a/anonymous' }] },
      { id: 'bundle/pkg-a', insert: [{ id: 'grp', name: 'cordis:group', group: true, config: [{ id: 'inner', name: 'pkg-a/inner' }] }] },
    ])
    expect(applyEntryPatches([], composed.patches, () => {})).toEqual([{
      id: 'bundle/pkg-a',
      name: CONTAINED_GROUP_MODULE,
      group: true,
      config: [
        { id: 'tool', name: 'pkg-a' },
        { name: 'pkg-a/anonymous' },
        { id: 'grp', name: 'cordis:group', group: true, config: [{ id: 'inner', name: 'pkg-a/inner' }] },
      ],
    }])
    expect([...composed.rows]).toEqual([
      ['tool', 'pkg-a'], ['grp', 'cordis:group'], ['inner', 'pkg-a/inner'], ['bundle/pkg-a', CONTAINED_GROUP_MODULE],
    ])
    expect(composed.duplicates).toEqual([])
    expect(composed.overrides).toEqual([])
  })

  it('keeps the written order of inserts and id-targeted patches, reporting patches on other rows as overrides', () => {
    const composed = composeExternalLayer(layer('pkg-b', [
      { insert: [{ id: 'own', name: 'pkg-b' }] },
      { id: 'own', config: { flag: true } },
      { id: 'settings', config: { path: '/x' } },
      { id: 'own', insert: [{ id: 'child', name: 'pkg-b/child' }] },
      { id: 'own', disabled: true },
      { disabled: true },
    ]))
    // A patch with no config, or no id at all, passes through as written; the include reports the latter.
    expect(composed.patches.slice(1)).toEqual([
      { id: 'bundle/pkg-b', insert: [{ id: 'own', name: 'pkg-b' }] },
      { id: 'own', config: { flag: true } },
      { id: 'settings', config: { path: '/x' } },
      { id: 'own', insert: [{ id: 'child', name: 'pkg-b/child' }] },
      { id: 'own', disabled: true },
      { disabled: true },
    ])
    expect(composed.overrides).toEqual(['settings'])
  })

  it('mounts a group config replaced and then appended to the same way a built-in layer would', () => {
    const written = (): PatchOptions[] => [
      { insert: [{ id: 'g', name: 'cordis:group', group: true, config: [{ id: 'x', name: 'pkg-o/x' }] }] },
      { id: 'g', config: [{ id: 'a', name: 'pkg-o/a' }] },
      { id: 'g', insert: [{ id: 'b', name: 'pkg-o/b' }] },
    ]
    const asBuiltin = applyEntryPatches([], written(), () => {})
    const contained = applyEntryPatches([], composeExternalLayer(layer('pkg-o', written())).patches, () => {})
    const childrenOf = (rows: EntryOptions[]): string[] => (rows.find(row => row.id === 'g')?.config as EntryOptions[]).map(row => row.id)
    expect(childrenOf(asBuiltin)).toEqual(['a', 'b'])
    expect(childrenOf(contained[0]?.config as EntryOptions[])).toEqual(['a', 'b'])
  })

  it('nests rows inserted into a built-in group inside one contained group per target', () => {
    const composed = composeExternalLayer(layer('pkg-c', [
      { id: 'persistent-shell', insert: [{ id: 'extra', name: 'pkg-c/extra' }] },
      { id: 'tools', insert: [{ id: 'tool-a', name: 'pkg-c/a' }] },
      { id: 'persistent-shell', insert: [{ id: 'more', name: 'pkg-c/more' }] },
    ]))
    expect(composed.patches).toEqual([
      { insert: [{ id: 'bundle/pkg-c', name: CONTAINED_GROUP_MODULE, group: true, config: [] }] },
      {
        id: 'persistent-shell',
        insert: [{ id: 'bundle/pkg-c/in/persistent-shell', name: CONTAINED_GROUP_MODULE, group: true, config: [{ id: 'extra', name: 'pkg-c/extra' }] }],
      },
      { id: 'tools', insert: [{ id: 'bundle/pkg-c/in/tools', name: CONTAINED_GROUP_MODULE, group: true, config: [{ id: 'tool-a', name: 'pkg-c/a' }] }] },
      { id: 'bundle/pkg-c/in/persistent-shell', insert: [{ id: 'more', name: 'pkg-c/more' }] },
    ])
    expect([...composed.rows.keys()].filter(id => id.includes('/in/'))).toEqual(['bundle/pkg-c/in/persistent-shell', 'bundle/pkg-c/in/tools'])
    const tree = applyEntryPatches([
      { id: 'persistent-shell', name: 'cordis:group', group: true, config: [] },
      { id: 'tools', name: 'cordis:group', group: true, config: [] },
    ], composed.patches, () => {})
    const shell = tree.find(row => row.id === 'persistent-shell')?.config as EntryOptions[]
    expect(shell.map(row => row.id)).toEqual(['bundle/pkg-c/in/persistent-shell'])
    expect((shell[0]?.config as EntryOptions[]).map(row => row.id)).toEqual(['extra', 'more'])
  })

  it('counts the rows a config override sets as the bundle\'s own, without calling a restated row a repeat', () => {
    const composed = composeExternalLayer(layer('pkg-v', [
      { insert: [{ id: 'own', name: 'cordis:group', group: true, config: [{ id: 'kept', name: 'pkg-v/kept' }] }] },
      { id: 'own', config: [{ id: 'kept', name: 'pkg-v/kept' }, { id: 'core', name: 'pkg-v/impostor' }, 'not a row' as never] },
      { id: 'own', insert: [{ id: 'child', name: 'pkg-v/child' }] },
    ]))
    expect([...composed.rows.keys()]).toEqual(['own', 'kept', 'core', 'child', 'bundle/pkg-v'])
    expect(composed.duplicates).toEqual([])
    expect(composed.overrides).toEqual([])
  })

  it('creates a new wrapper after a patch replaced the target group\'s config', () => {
    const composed = composeExternalLayer(layer('pkg-w', [
      { id: 'tools', insert: [{ id: 'first', name: 'pkg-w/a' }] },
      { id: 'tools', config: [] },
      { id: 'tools', insert: [{ id: 'last', name: 'pkg-w/b' }] },
    ]))
    expect(composed.patches.slice(1)).toEqual([
      { id: 'tools', insert: [{ id: 'bundle/pkg-w/in/tools', name: CONTAINED_GROUP_MODULE, group: true, config: [{ id: 'first', name: 'pkg-w/a' }] }] },
      { id: 'tools', config: [] },
      { id: 'tools', insert: [{ id: 'bundle/pkg-w/in/tools', name: CONTAINED_GROUP_MODULE, group: true, config: [{ id: 'last', name: 'pkg-w/b' }] }] },
    ])
    expect(composed.duplicates).toEqual([])
    const tree = applyEntryPatches([{ id: 'tools', name: 'cordis:group', group: true, config: [] }], composed.patches, () => {})
    const tools = tree.find(row => row.id === 'tools')?.config as EntryOptions[]
    expect(tools.map(row => row.id)).toEqual(['bundle/pkg-w/in/tools'])
    expect((tools[0]?.config as EntryOptions[]).map(row => row.id)).toEqual(['last'])
  })

  it('reports a declared row that spells a wrapper\'s id as a repeat', () => {
    const composed = composeExternalLayer(layer('pkg-i', [
      { insert: [{ id: 'bundle/pkg-i/in/tools', name: 'pkg-i/impostor' }] },
      { id: 'tools', insert: [{ id: 'tool', name: 'pkg-i/tool' }] },
    ]))
    expect(composed.duplicates).toEqual([{ rowId: 'bundle/pkg-i/in/tools', moduleName: CONTAINED_GROUP_MODULE }])
  })

  it('reports an id the bundle inserts twice and keeps the first module for it', () => {
    const composed = composeExternalLayer(layer('pkg-r', [
      { insert: [{ id: 'dup', name: 'pkg-r/one' }] },
      { insert: [{ id: 'g', name: 'cordis:group', group: true, config: [{ id: 'dup', name: 'pkg-r/two' }] }] },
      { insert: [{ id: 'bundle/pkg-r', name: 'pkg-r/steals-the-group-id' }] },
    ]))
    expect(composed.duplicates).toEqual([
      { rowId: 'dup', moduleName: 'pkg-r/two' },
      { rowId: 'bundle/pkg-r', moduleName: CONTAINED_GROUP_MODULE },
    ])
    expect(composed.rows.get('dup')).toBe('pkg-r/one')
  })

  it('reports a config override that lists one id twice or sets a row under a group other than the one holding it', () => {
    const composed = composeExternalLayer(layer('pkg-o', [
      { insert: [
        { id: 'a', name: 'cordis:group', group: true, config: [{ id: 'shared', name: 'pkg-o/x' }] },
        { id: 'b', name: 'cordis:group', group: true, config: [] },
      ] },
      { id: 'b', config: [{ id: 'shared', name: 'pkg-o/moved' }] },
      { id: 'a', config: [{ id: 'twice', name: 'pkg-o/one' }, { id: 'twice', name: 'pkg-o/two' }] },
      // The bundle's own group is a predictable target: a duplicate under it
      // would fail the group's update before any row is contained.
      { id: 'bundle/pkg-o', config: [{ id: 'own', name: 'pkg-o/own' }, { id: 'own', name: 'pkg-o/own-again' }] },
    ]))
    expect(composed.duplicates).toEqual([
      { rowId: 'shared', moduleName: 'pkg-o/moved' },
      { rowId: 'twice', moduleName: 'pkg-o/two' },
      { rowId: 'own', moduleName: 'pkg-o/own-again' },
    ])
    expect(composed.overrides).toEqual([])
  })

  it('lets a config override restate a row under the built-in group it was inserted into', () => {
    const composed = composeExternalLayer(layer('pkg-s', [
      { id: 'tools', insert: [{ id: 'tool', name: 'pkg-s/tool' }] },
      { id: 'tools', config: [{ id: 'tool', name: 'pkg-s/tool' }] },
    ]))
    expect(composed.duplicates).toEqual([])
    expect(composed.overrides).toEqual(['tools'])
  })

  it('never mutates the layer\'s own patch objects', () => {
    const patches: PatchOptions[] = [{ insert: [{ id: 'row', name: 'pkg-d' }] }, { id: 'row', config: { a: 1 } }]
    const snapshot = structuredClone(patches)
    composeExternalLayer(layer('pkg-d', patches))
    expect(patches).toEqual(snapshot)
  })

  it('mounts the same tree when its patches are applied twice, as a rolled-back update re-applies them', () => {
    const composed = composeExternalLayer(layer('pkg-t', [
      { insert: [{ id: 'row', name: 'pkg-t' }] },
      { id: 'tools', insert: [{ id: 'tool', name: 'pkg-t/tool' }] },
      { id: 'tools', config: [] },
      { id: 'tools', insert: [{ id: 'later', name: 'pkg-t/later' }] },
    ]))
    const snapshot = structuredClone(composed.patches)
    const base = (): EntryOptions[] => [{ id: 'tools', name: 'cordis:group', group: true, config: [] }]
    const first = applyEntryPatches(base(), composed.patches, () => {})
    const second = applyEntryPatches(base(), composed.patches, () => {})
    expect(second).toEqual(first)
    // Neither the inserted rows nor the override values were mutated by either application.
    expect(composed.patches).toEqual(snapshot)
    expect((first[1]?.config as EntryOptions[]).map(row => row.id)).toEqual(['row'])
    const tools = first[0]?.config as EntryOptions[]
    expect((tools[0]?.config as EntryOptions[]).map(row => row.id)).toEqual(['later'])
  })

  it('spells the group id without the Loader\'s nested-id separator', () => {
    expect(bundleGroupId('@scope/pkg')).toBe('bundle/@scope/pkg')
    expect(bundleGroupId('x')).not.toContain(':')
  })

  it('contains only runtime-staged external layers', () => {
    const contained = layer('pkg-e', [{ insert: [{ id: 'row', name: 'pkg-e' }] }])
    expect(isContainedLayer(contained)).toBe(true)
    expect(isContainedLayer({ ...contained, stage: 'boot' })).toBe(false)
    expect(isContainedLayer({ ...contained, trust: 'builtin' })).toBe(false)
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

  it('keeps a bundle the user disabled out of the list through later runs, and enables one an update turned into a bundle', () => {
    const { profileDir, installAnchor } = stageProfile({ 'ext-bundle': { bundle: true }, 'late-bundle': {} })
    const installed = readProfileManifest(NAME, profileDir)
    expect(reconcileInstalledBundles(NAME, profileDir, installAnchor, { dependencies: {} }, { autoEnable: true }))
      .toEqual({ enabled: ['ext-bundle'], removed: [], plain: ['late-bundle'], installedOnly: [] })
    expect(disableBundle(NAME, profileDir, 'ext-bundle')).toBe(true)
    expect(readProfileManifest(NAME, profileDir).dsh?.profile).toEqual({ bundles: ['@deepseek-ai/dsh-base'], disabledBundles: ['ext-bundle'] })
    // An update made late-bundle a bundle; ext-bundle is still installed and still disabled.
    const late = join(profileDir, 'node_modules', 'late-bundle')
    writeFileSync(join(late, 'package.json'), JSON.stringify({ name: 'late-bundle', version: '2.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    writeFileSync(join(late, 'cordis.patch.yml'), '[]\n')
    expect(reconcileInstalledBundles(NAME, profileDir, installAnchor, installed, { autoEnable: false }))
      .toEqual({ enabled: [], removed: [], plain: [], installedOnly: ['late-bundle'] })
    expect(reconcileInstalledBundles(NAME, profileDir, installAnchor, installed, { autoEnable: true }))
      .toEqual({ enabled: ['late-bundle'], removed: [], plain: [], installedOnly: [] })
    expect(readProfileManifest(NAME, profileDir).dsh?.profile).toEqual({ bundles: ['@deepseek-ai/dsh-base', 'late-bundle'], disabledBundles: ['ext-bundle'] })
    // Enabling again drops the record.
    expect(enableBundle(NAME, profileDir, installAnchor, 'ext-bundle')).toBe(true)
    expect(readProfileManifest(NAME, profileDir).dsh?.profile).toEqual({ bundles: ['@deepseek-ai/dsh-base', 'late-bundle', 'ext-bundle'] })
  })

  it('keeps a listed bundle listed once when the run brings its dependency back', () => {
    const { profileDir, installAnchor } = stageProfile({ 'ext-bundle': { bundle: true } })
    enableBundle(NAME, profileDir, installAnchor, 'ext-bundle')
    // The manifest the run started with had lost the dependency; pnpm added it again.
    expect(reconcileInstalledBundles(NAME, profileDir, installAnchor, { dependencies: {} }, { autoEnable: true }))
      .toEqual({ enabled: [], removed: [], plain: [], installedOnly: [] })
    expect(readProfileManifest(NAME, profileDir).dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base', 'ext-bundle'])
  })

  it('drops a layer whose dependency was removed, and the disabled record of one, keeping template bundles', () => {
    const { profileDir, installAnchor } = stageProfile({ 'ext-bundle': { bundle: true }, 'off-bundle': { bundle: true } })
    enableBundle(NAME, profileDir, installAnchor, 'ext-bundle')
    enableBundle(NAME, profileDir, installAnchor, 'off-bundle')
    disableBundle(NAME, profileDir, 'off-bundle')
    const manifest = readProfileManifest(NAME, profileDir)
    // pnpm removed both dependencies; the lists still name them.
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
