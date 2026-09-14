/** Bundle patch ownership and the profile manifest's installed/enabled layer lists. */

import { join } from 'node:path'
import { visitIdentifiedRows } from './patch-rows.ts'
import {
  readProfileManifest, resolveBundleDir, writeProfileManifest, type ProfileLayer, type ProfileManifest,
} from './profile.ts'

/** One row declared twice within a bundle layer. */
interface DuplicateRow {
  readonly rowId: string
  readonly moduleName: string
}

/** Declared row ids and duplicates within one bundle patch list. */
interface AnalyzedBundleLayer {
  readonly rows: Map<string, string>
  readonly duplicates: DuplicateRow[]
}

/**
 * Inspect the rows a layer introduces without changing their ids or parents.
 * @param layer - the bundle patch list.
 * @returns its declared rows and duplicates.
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
  return { rows, duplicates }
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
 * Reconcile the enabled layer list after a pnpm run. Existing dependencies
 * retain their enabled selection, including packages whose update adds a
 * bundle patch. Only new dependencies may join the list when `autoEnable`
 * is set; otherwise they are reported as installed-only. Removed or
 * bundle-less dependencies leave the list; template bundles are untouched.
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
    if (beforeDeps.has(packageName)) continue
    if (!exportsBundlePatch(binName, packageName, installAnchor, profileDir)) {
      outcome.plain.push(packageName)
      continue
    }
    if (bundles.includes(packageName)) continue
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
  if (outcome.enabled.length > 0 || outcome.removed.length > 0) {
    writeProfileManifest(profileDir, withBundles(after, bundles))
  }
  return outcome
}

/** Replace the ordered enabled layers while preserving the remaining manifest fields. */
function withBundles(manifest: ProfileManifest, bundles: string[]): ProfileManifest {
  return { ...manifest, dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } } }
}

/**
 * Add one installed bundle to the profile's enabled layer list.
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
 * Remove one dependency-managed bundle from the enabled layer list.
 * Its dependency remains installed and later reconciliation leaves it off.
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
  writeProfileManifest(profileDir, withBundles(
    manifest, bundles.filter(name => name !== packageName),
  ))
  return true
}
