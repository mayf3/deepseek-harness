/**
 * External bundle composition and the profile-manifest operations behind
 * installing, enabling, and disabling bundles.
 *
 * An external (`runtime` stage) bundle never mounts its rows directly into the
 * built-in tree: its inserted rows are wrapped in one contained group per
 * bundle, under the ids its patch declares. A group is the unit the Loader
 * updates transactionally, and the contained variant catches each row's
 * failure inside that transaction: the failing row is recorded, its siblings
 * mount, and the built-in tree never sees a rejection. Row ids stay as
 * declared; entry ids are unique per tree (`tree.store`), and
 * `compose-stack.ts` owns the tree-wide ownership check that shared id
 * namespace requires.
 * @module @deepseek-ai/dsh-app-boot/external-bundles
 */

import { join } from 'node:path'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { DshProfileManifest } from '@deepseek-ai/dsh-package-manifest'
import { visitIdentifiedRows } from './patch-rows.ts'
import {
  readProfileManifest, resolveBundleDir, writeProfileManifest, type ProfileLayer, type ProfileManifest,
} from './profile.ts'

/** Loader builtin name of the contained group every `runtime` bundle mounts under. */
export const CONTAINED_GROUP_MODULE = 'cordis:contained-group'

/** Prefix of the group id one external bundle's rows mount under. */
export const BUNDLE_GROUP_PREFIX = 'bundle/'

/**
 * The group id one external bundle's rows mount under. `/` rather than `:`
 * because `:` is the Loader's nested-id separator (`EntryTree.sep`), and an
 * id containing it would not resolve through `loader.update(id, …)`.
 * @param packageName - the bundle's package name.
 * @returns the group entry id.
 */
export function bundleGroupId(packageName: string): string {
  return `${BUNDLE_GROUP_PREFIX}${packageName}`
}

/** One id an external bundle's patch introduces twice: a row inserted again, or a row spelling the group's or a wrapper's id. */
export interface DuplicateRow {
  /** The repeated id. */
  readonly rowId: string
  /** The module the repeat names. */
  readonly moduleName: string
}

/** One external layer rendered as the patches the tree mounts. */
export interface ComposedExternalLayer {
  /**
   * Patches in application order: the empty group insert, then the bundle's
   * patches as written, each insert re-targeted into the group or a wrapper.
   */
  patches: PatchOptions[]
  /**
   * Every id the layer introduces — its inserted rows, the rows its config
   * overrides set, its group, and each wrapper group — with the module each
   * names; a repeated id keeps its first module.
   */
  rows: Map<string, string>
  /**
   * Ids the layer introduces more than once, in order of repetition. A config
   * override restating a row under the group that already holds it is not
   * one; the same id twice in one config list, or set under another group, is.
   */
  duplicates: DuplicateRow[]
  /** Ids outside the bundle that its patch overrides; not containable, reported for visibility. */
  overrides: string[]
}

/**
 * Whether a layer mounts isolated: an external bundle the profile does not
 * stage at boot.
 * @param layer - the resolved layer.
 * @returns true when the layer mounts as a contained group.
 */
export function isContainedLayer(layer: ProfileLayer): boolean {
  return layer.trust === 'external' && layer.stage === 'runtime'
}

/**
 * Render one external bundle layer as contained patches in the order written.
 * The bundle's group is inserted empty first; each root insert becomes an
 * insert into that group, an insert into a row the bundle itself introduces
 * passes through, and every insert into one built-in group lands in one
 * wrapper group nested inside that target — the first insert creates it,
 * later ones insert into it, and a patch that replaces the target's config
 * has removed the wrapper, so the next insert creates a new one under the
 * same id. An id-targeted patch passes through unchanged and is reported as
 * an override when it addresses a row the bundle did not introduce; the rows
 * it sets as a group's config count as the bundle's own, since they mount
 * as children like inserted ones. Every id, declared or generated, goes
 * through one registration, so a row spelling a wrapper's id is a duplicate,
 * and so is a config row the bundle already declared under another group,
 * or listed twice: the Loader would move the first and reject the second.
 * Ids are indexed before any patch is emitted, so an insert into a group the
 * bundle introduces later in its list still counts as its own.
 * @param layer - the resolved external layer.
 * @returns the patches to mount, the ids the layer introduces, and the ids it repeats.
 */
export function composeExternalLayer(layer: ProfileLayer): ComposedExternalLayer {
  const groupId = bundleGroupId(layer.packageName)
  const rows = new Map<string, string>()
  const declaredUnder = new Map<string, string | undefined>()
  const duplicates: DuplicateRow[] = []
  const claim = (rowId: string, moduleName: string, target?: string): void => {
    if (rows.has(rowId)) {
      duplicates.push({ rowId, moduleName })
      return
    }
    rows.set(rowId, moduleName)
    declaredUnder.set(rowId, target)
  }
  visitIdentifiedRows(layer.patches, ({ id, row, source, place, listed }) => {
    // A root insert lands in the bundle's group: that is the group it declares under.
    const target = place.target ?? groupId
    if (source === 'config') {
      // A config override restates the children it keeps: the same id declared
      // under the same group before is that row. Twice in one list, or under
      // another group, it would mount as a rejected duplicate or move the row.
      if (listed.has(id) || (rows.has(id) && declaredUnder.get(id) !== target)) {
        duplicates.push({ rowId: id, moduleName: row.name })
      } else if (!rows.has(id)) {
        rows.set(id, row.name)
        declaredUnder.set(id, target)
      }
    } else {
      claim(id, row.name, target)
    }
  })
  claim(groupId, CONTAINED_GROUP_MODULE)
  const wrappers = new Map<string, string>()
  const generated = new Set<string>()
  const overrides: string[] = []
  const patches: PatchOptions[] = [{ insert: [{ id: groupId, name: CONTAINED_GROUP_MODULE, group: true, config: [] }] }]
  for (const patch of layer.patches) {
    if (patch.insert === undefined) {
      if (patch.id !== undefined) {
        if (!rows.has(patch.id)) overrides.push(patch.id)
        // The target's children are replaced, wrapper included.
        if (patch.config !== undefined) wrappers.delete(patch.id)
      }
      patches.push(structuredClone(patch))
      continue
    }
    const inserted = structuredClone(patch.insert)
    const target = patch.id ?? groupId
    if (rows.has(target)) {
      patches.push({ id: target, insert: inserted })
      continue
    }
    const wrapper = wrappers.get(target)
    if (wrapper !== undefined) {
      patches.push({ id: wrapper, insert: inserted })
      continue
    }
    const wrapperId = `${groupId}/in/${target}`
    if (!generated.has(wrapperId)) {
      generated.add(wrapperId)
      claim(wrapperId, CONTAINED_GROUP_MODULE)
    }
    wrappers.set(target, wrapperId)
    patches.push({ id: target, insert: [{ id: wrapperId, name: CONTAINED_GROUP_MODULE, group: true, config: inserted }] })
  }
  return { patches, rows, duplicates, overrides }
}

/**
 * Whether an installed dependency exports a profile patch, i.e. is a bundle.
 * @param binName - the diagnostic prefix used by manifest reads.
 * @param packageName - the dependency's package name.
 * @param installAnchor - absolute path of the dsh app's package.json.
 * @param profileDir - the profile directory (second resolution anchor).
 * @returns true when the package manifest declares `dsh.bundle`.
 */
export function exportsBundlePatch(
  binName: string, packageName: string, installAnchor: string, profileDir: string,
): boolean {
  let dir: string
  try {
    dir = resolveBundleDir(binName, packageName, installAnchor, profileDir)
  } catch {
    return false // pnpm reported success yet the package is unresolvable — treat as plain
  }
  return readProfileManifest(binName, dir).dsh?.bundle?.patch !== undefined
}

/** Outcome of one reconciliation of the bundle layer list against installed state. */
export interface BundleReconciliation {
  /** Bundles newly enabled (appended to `dsh.profile.bundles`). */
  enabled: string[]
  /** Bundles removed from the layer list because their dependency is gone or no longer a bundle. */
  removed: string[]
  /** Newly added dependencies that declare no `dsh.bundle` (plain libraries or plugin modules). */
  plain: string[]
  /** Bundles the run installed and left out of the layer list because `autoEnable` was off. */
  installedOnly: string[]
}

/**
 * Reconcile `dsh.profile.bundles` against the installed state after a pnpm
 * run. A dependency that no longer resolves to a bundle leaves the layer
 * list; template bundles (never dependencies) are untouched. A bundle in
 * neither list — one the run added, or a dependency whose update declared
 * `dsh.bundle` — joins the layer list only when `autoEnable` is set, the
 * CLI's install-and-enable semantics, and is otherwise reported as
 * installed-only, the plugin manager's install step. A bundle the user
 * disabled is named in `dsh.profile.disabledBundles` and stays out through
 * every later run until enabled again; the record goes when its dependency
 * does.
 * @param binName - the diagnostic prefix used by manifest reads.
 * @param profileDir - the profile directory.
 * @param installAnchor - absolute path of the dsh app's package.json.
 * @param before - the manifest as read before the pnpm run.
 * @param options - whether newly installed bundles join the layer list.
 * @returns what changed, after the manifest was written when anything did.
 */
export function reconcileInstalledBundles(
  binName: string,
  profileDir: string,
  installAnchor: string,
  before: ProfileManifest,
  options: { autoEnable: boolean },
): BundleReconciliation {
  const after = readProfileManifest(binName, profileDir)
  const beforeDeps = new Set(Object.keys(before.dependencies ?? {}))
  const dependencies = Object.keys(after.dependencies ?? {})
  const bundles = [...after.dsh?.profile?.bundles ?? []]
  const disabled = after.dsh?.profile?.disabledBundles ?? []
  const outcome: BundleReconciliation = { enabled: [], removed: [], plain: [], installedOnly: [] }
  for (const packageName of dependencies) {
    if (!exportsBundlePatch(binName, packageName, installAnchor, profileDir)) {
      if (!beforeDeps.has(packageName)) outcome.plain.push(packageName)
      continue
    }
    if (bundles.includes(packageName) || disabled.includes(packageName)) continue
    if (options.autoEnable) {
      bundles.push(packageName)
      outcome.enabled.push(packageName)
    } else {
      outcome.installedOnly.push(packageName)
    }
  }
  const dependencySet = new Set(dependencies)
  const stillBundle = (packageName: string): boolean => (
    dependencySet.has(packageName) && exportsBundlePatch(binName, packageName, installAnchor, profileDir)
  )
  for (const packageName of [...bundles]) {
    // Only dependency-managed entries are subject to removal; template
    // bundles are not dependencies.
    const wasDependency = beforeDeps.has(packageName) || dependencySet.has(packageName)
    if (wasDependency && !stillBundle(packageName)) {
      bundles.splice(bundles.indexOf(packageName), 1)
      outcome.removed.push(packageName)
    }
  }
  // A disabled bundle whose dependency is gone, or no longer a bundle, has nothing left to keep out.
  const stillDisabled = disabled.filter(stillBundle)
  if (outcome.enabled.length > 0 || outcome.removed.length > 0 || stillDisabled.length !== disabled.length) {
    writeProfileManifest(profileDir, withBundles(after, bundles, stillDisabled))
  }
  return outcome
}

/** The manifest with its bundle lists replaced, every other field kept; an empty disabled list leaves the field out. */
function withBundles(manifest: ProfileManifest, bundles: string[], disabled: readonly string[]): ProfileManifest {
  const profile: DshProfileManifest = { ...manifest.dsh?.profile, bundles }
  if (disabled.length > 0) profile.disabledBundles = [...disabled]
  else delete profile.disabledBundles
  return { ...manifest, dsh: { ...manifest.dsh, profile } }
}

/**
 * Add one installed bundle to the profile's layer list and drop its disabled record.
 * @param binName - the diagnostic prefix on thrown errors.
 * @param profileDir - the profile directory.
 * @param installAnchor - absolute path of the dsh app's package.json.
 * @param packageName - the installed dependency to enable.
 * @returns true when the list changed; false when the bundle was already enabled.
 * @throws when the package is not an installed dependency or declares no `dsh.bundle`.
 */
export function enableBundle(binName: string, profileDir: string, installAnchor: string, packageName: string): boolean {
  const manifest = readProfileManifest(binName, profileDir)
  if (!(packageName in (manifest.dependencies ?? {}))) {
    throw new Error(`${binName}: ${packageName} is not installed in profile ${join(profileDir, 'package.json')}`)
  }
  if (!exportsBundlePatch(binName, packageName, installAnchor, profileDir)) {
    throw new Error(`${binName}: ${packageName} declares no dsh.bundle; add its plugin modules to a composition instead of enabling it`)
  }
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (bundles.includes(packageName)) return false
  const disabled = (manifest.dsh?.profile?.disabledBundles ?? []).filter(name => name !== packageName)
  writeProfileManifest(profileDir, withBundles(manifest, [...bundles, packageName], disabled))
  return true
}

/**
 * Remove one dependency-managed bundle from the profile's layer list and
 * record it as disabled, so reconciliation leaves it out until `enableBundle`.
 * @param binName - the diagnostic prefix on thrown errors.
 * @param profileDir - the profile directory.
 * @param packageName - the bundle to disable.
 * @returns true when the list changed; false when the bundle was not enabled.
 * @throws when the bundle is a template bundle, which is not a dependency and cannot be disabled.
 */
export function disableBundle(binName: string, profileDir: string, packageName: string): boolean {
  const manifest = readProfileManifest(binName, profileDir)
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (!bundles.includes(packageName)) return false
  if (!(packageName in (manifest.dependencies ?? {}))) {
    throw new Error(`${binName}: ${packageName} is a template bundle of this profile and cannot be disabled`)
  }
  const disabled = manifest.dsh?.profile?.disabledBundles ?? []
  writeProfileManifest(profileDir, withBundles(
    manifest, bundles.filter(name => name !== packageName), [...new Set([...disabled, packageName])],
  ))
  return true
}
