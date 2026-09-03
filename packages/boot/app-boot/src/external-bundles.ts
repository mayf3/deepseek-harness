/**
 * External bundle composition and the profile-manifest operations behind
 * installing, enabling, and disabling bundles.
 *
 * An external (`runtime` stage) bundle never mounts its rows directly into the
 * built-in tree. Its inserted rows are wrapped in one contained group per
 * bundle, each row id is prefixed with the package name, and the bundle's own
 * patches that address those rows are rewritten to the prefixed ids. Two
 * facts of the vendored Loader make this necessary: entry ids are unique per
 * tree (`tree.store`), so two bundles inserting the same id would otherwise
 * make the second silently take over the first's entry; and a group is the
 * unit the Loader rolls back, so one group per bundle is what makes a bundle
 * fail as a whole rather than half-mount.
 * @module @deepseek-ai/dsh-app-boot/external-bundles
 */

import { join } from 'node:path'
import { isJsExpr, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'

/**
 * Whether a `disabled` node is a `!!js` expression rather than a literal.
 * @param value - the raw `disabled` node of a row or patch.
 * @returns true for an expression node.
 */
export function isJsDisabled(value: unknown): boolean {
  return isJsExpr(value)
}
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

/**
 * The tree-wide id of one row an external bundle inserted.
 * @param packageName - the bundle's package name.
 * @param rowId - the id the bundle's own patch declares.
 * @returns the prefixed id the mounted tree uses.
 */
export function externalRowId(packageName: string, rowId: string): string {
  return `${packageName}/${rowId}`
}

/** Where one mounted row came from, keyed by its tree-wide id. */
export interface ExternalRowOrigin {
  /** The bundle that inserted the row. */
  packageName: string
  /** The id the bundle's own patch declared, before prefixing. */
  originalId: string
}

/** One external layer rendered as the patches the tree mounts. */
export interface ComposedExternalLayer {
  /** Patches in application order: the group insert first, then the bundle's rewritten patches. */
  patches: PatchOptions[]
  /** Every row the bundle inserted, by prefixed id. */
  rows: Map<string, ExternalRowOrigin>
  /** Built-in row ids the bundle overrides; not containable, reported for visibility. */
  overrides: string[]
}

/** Deep-clone one entry row and prefix its id and, for a group, its children's ids. */
function prefixRow(packageName: string, row: EntryOptions, rows: Map<string, ExternalRowOrigin>, ownIds: Set<string>): EntryOptions {
  const cloned = structuredClone(row)
  if (typeof cloned.id === 'string') {
    ownIds.add(cloned.id)
    const prefixed = externalRowId(packageName, cloned.id)
    rows.set(prefixed, { packageName, originalId: cloned.id })
    cloned.id = prefixed
  }
  if (cloned.group && Array.isArray(cloned.config)) {
    cloned.config = (cloned.config as EntryOptions[]).map(child => prefixRow(packageName, child, rows, ownIds))
  }
  return cloned
}

/**
 * Render one external bundle layer as contained, prefixed patches. Root
 * inserts become the children of the bundle's group; inserts into a named
 * group the bundle itself introduced follow the prefixed id; inserts into a
 * built-in group are nested in their own contained group inside that target;
 * an id-targeted patch is rewritten when it addresses a row this bundle
 * inserted and passed through unchanged when it addresses a built-in row.
 * @param layer - the resolved external layer.
 * @returns the patches to mount and the provenance of every inserted row.
 */
export function composeExternalLayer(layer: ProfileLayer): ComposedExternalLayer {
  const { packageName } = layer
  const rows = new Map<string, ExternalRowOrigin>()
  const ownIds = new Set<string>()
  const groupRows: EntryOptions[] = []
  const trailing: PatchOptions[] = []
  const overrides: string[] = []
  // First pass: inserts, so the ids this bundle introduces are known before
  // its id-targeted patches are classified.
  for (const patch of layer.patches) {
    if (patch.insert === undefined) continue
    const inserted = patch.insert.map(row => prefixRow(packageName, row, rows, ownIds))
    if (patch.id === undefined) {
      groupRows.push(...inserted)
      continue
    }
    if (ownIds.has(patch.id)) {
      trailing.push({ id: externalRowId(packageName, patch.id), insert: inserted })
      continue
    }
    const nestedId = `${bundleGroupId(packageName)}/in/${patch.id}`
    rows.set(nestedId, { packageName, originalId: nestedId })
    trailing.push({
      id: patch.id,
      insert: [{ id: nestedId, name: CONTAINED_GROUP_MODULE, group: true, config: inserted }],
    })
  }
  for (const patch of layer.patches) {
    if (patch.insert !== undefined || patch.id === undefined) continue
    if (ownIds.has(patch.id)) {
      trailing.push({ ...structuredClone(patch), id: externalRowId(packageName, patch.id) })
      continue
    }
    overrides.push(patch.id)
    trailing.push(structuredClone(patch))
  }
  const groupId = bundleGroupId(packageName)
  rows.set(groupId, { packageName, originalId: groupId })
  const group: EntryOptions = { id: groupId, name: CONTAINED_GROUP_MODULE, group: true, config: groupRows }
  return { patches: [{ insert: [group] }, ...trailing], rows, overrides }
}

/**
 * The patches one bundle layer contributes. A built-in layer, or an external
 * layer the profile stages at boot, mounts its patches as written; every other
 * external layer mounts as one contained, id-prefixed group.
 * @param layer - the resolved layer.
 * @returns the layer's patches in application order.
 */
export function bundleLayerPatches(layer: ProfileLayer): PatchOptions[] {
  if (layer.trust === 'external' && layer.stage === 'runtime') return composeExternalLayer(layer).patches
  return layer.patches
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
  /** Installed bundles left out of the layer list because `autoEnable` was off. */
  installedOnly: string[]
}

/**
 * Reconcile `dsh.profile.bundles` against the installed state after a pnpm
 * run. A dependency that no longer resolves to a bundle leaves the layer
 * list; template bundles (never dependencies) are untouched. A dependency
 * that resolves to a bundle joins the list only when `autoEnable` is set —
 * the CLI's install-and-enable semantics — and is otherwise reported as
 * installed-only, which is the plugin manager's install step.
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
  const outcome: BundleReconciliation = { enabled: [], removed: [], plain: [], installedOnly: [] }
  for (const packageName of dependencies) {
    const isBundle = exportsBundlePatch(binName, packageName, installAnchor, profileDir)
    if (isBundle && !bundles.includes(packageName)) {
      if (options.autoEnable) {
        bundles.push(packageName)
        outcome.enabled.push(packageName)
      } else {
        outcome.installedOnly.push(packageName)
      }
    } else if (!isBundle && !beforeDeps.has(packageName)) {
      outcome.plain.push(packageName)
    }
  }
  const dependencySet = new Set(dependencies)
  for (const packageName of [...bundles]) {
    // Only dependency-managed entries are subject to removal; template
    // bundles are not dependencies.
    const wasDependency = beforeDeps.has(packageName) || dependencySet.has(packageName)
    const stillBundle = dependencySet.has(packageName) && exportsBundlePatch(binName, packageName, installAnchor, profileDir)
    if (wasDependency && !stillBundle) {
      bundles.splice(bundles.indexOf(packageName), 1)
      outcome.removed.push(packageName)
    }
  }
  if (outcome.enabled.length > 0 || outcome.removed.length > 0) {
    writeProfileManifest(profileDir, withBundles(after, bundles))
  }
  return outcome
}

/** The manifest with its bundle layer list replaced, every other field kept. */
function withBundles(manifest: ProfileManifest, bundles: string[]): ProfileManifest {
  return { ...manifest, dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } } }
}

/**
 * Add one installed bundle to the profile's layer list.
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
  writeProfileManifest(profileDir, withBundles(manifest, [...bundles, packageName]))
  return true
}

/**
 * Remove one dependency-managed bundle from the profile's layer list.
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
  writeProfileManifest(profileDir, withBundles(manifest, bundles.filter(name => name !== packageName)))
  return true
}
