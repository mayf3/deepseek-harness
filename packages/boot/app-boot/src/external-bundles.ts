/** Bundle patch ownership and the profile manifest's installed/enabled layer lists. */

import { join } from 'node:path'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { DshProfileManifest } from '@deepseek-ai/dsh-package-manifest'
import { visitIdentifiedRows } from './patch-rows.ts'
import {
  readProfileManifest, resolveBundleDir, writeProfileManifest, type ProfileLayer, type ProfileManifest,
} from './profile.ts'

/** One row declared twice within a bundle layer. */
export interface DuplicateRow {
  readonly rowId: string
  readonly moduleName: string
}

/** Static row ownership and overrides of one unmodified bundle patch list. */
export interface AnalyzedBundleLayer {
  readonly patches: PatchOptions[]
  readonly rows: Map<string, string>
  readonly duplicates: DuplicateRow[]
  readonly overrides: string[]
}

/**
 * Inspect the rows a layer introduces without changing their ids or parents.
 * @param layer - the bundle patch list.
 * @returns its declared rows, duplicates, and external override targets.
 */
export function analyzeBundleLayer(layer: ProfileLayer): AnalyzedBundleLayer {
  const rows = new Map<string, string>()
  const declaredUnder = new Map<string, string | undefined>()
  const duplicates: DuplicateRow[] = []
  visitIdentifiedRows(layer.patches, ({ id, row, source, place, listed }) => {
    if (rows.has(id)) {
      if (source === 'insert' || listed.has(id) || declaredUnder.get(id) !== place.target) {
        duplicates.push({ rowId: id, moduleName: row.name })
      }
    } else {
      rows.set(id, row.name)
      declaredUnder.set(id, place.target)
    }
  })
  const overrides = layer.patches.flatMap(patch => (
    patch.insert === undefined && patch.id !== undefined && !rows.has(patch.id) ? [patch.id] : []
  ))
  return { patches: layer.patches, rows, duplicates, overrides }
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
