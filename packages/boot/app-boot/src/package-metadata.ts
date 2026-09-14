/** Installed package declarations read without importing or executing their modules. */
import { createRequire } from 'node:module'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadOverlayPatches } from './index.ts'
import { readProfileManifest, resolveBundleDir } from './profile.ts'
import { visitPatchRows } from './patch-rows.ts'

/** One configured bundle row; conditions remain unevaluated until it mounts. */
export interface PackageMetadataRow {
  readonly id?: string
  readonly name: string
  readonly gated: boolean
}

/** Static facts; a declaration is not an activation verdict. */
export interface PackageMetadata {
  readonly packageName: string
  readonly version?: string
  readonly description?: string
  readonly title?: string
  readonly kind: 'bundle' | 'unknown'
  readonly enginesDsh?: string
  /** Physical resolution only; null when unavailable, not an execution guarantee. */
  readonly cordisSameCopy: boolean | null
  readonly rows: readonly PackageMetadataRow[]
  readonly overrides: readonly string[]
}

/** Locations needed to read one installed package. */
export interface PackageMetadataOptions {
  readonly binName: string
  readonly packageName: string
  readonly profileDir: string
  readonly installAnchor: string
}

/**
 * Read package identity and bundle rows without loading code.
 * @param options - installation and profile resolution anchors.
 * @returns declared metadata; packages without a bundle patch remain unknown.
 * @throws when the package or its declaration cannot be read or parsed.
 */
export function readPackageMetadata(options: PackageMetadataOptions): PackageMetadata {
  const { binName, packageName, installAnchor, profileDir } = options
  const dir = resolveBundleDir(binName, packageName, installAnchor, profileDir)
  const manifest = readProfileManifest(binName, dir)
  const rows: PackageMetadataRow[] = []
  const own = new Set<string>()
  const declaredBundle = manifest.dsh?.bundle?.patch
  const patches = declaredBundle === undefined ? [] : loadOverlayPatches(binName, join(dir, declaredBundle))
  visitPatchRows(patches, (row) => {
    if (typeof row.id === 'string') own.add(row.id)
    rows.push({ ...typeof row.id === 'string' ? { id: row.id } : {}, name: row.name, gated: row.disabled !== undefined && row.disabled !== false })
  })
  const overrides = patches.flatMap(patch => patch.insert === undefined && typeof patch.id === 'string' && !own.has(patch.id) ? [patch.id] : [])
  const cordisSameCopy = compareCordisCopies(dir)
  return {
    packageName,
    ...manifest.version === undefined ? {} : { version: manifest.version },
    ...manifest.description === undefined ? {} : { description: manifest.description },
    ...manifest.dsh?.title === undefined ? {} : { title: manifest.dsh.title },
    ...manifest.engines?.dsh === undefined ? {} : { enginesDsh: manifest.engines.dsh },
    kind: declaredBundle !== undefined ? 'bundle' : 'unknown',
    cordisSameCopy, rows, overrides,
  }
}

/** Resolve physical package identity through a packaged-runtime module proxy. */
function cordisPackageDir(resolved: string): string | undefined {
  let dir = dirname(resolved.startsWith('file:') ? fileURLToPath(resolved) : resolved)
  for (;;) {
    const path = join(dir, 'package.json')
    if (existsSync(path)) {
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as { name?: string; dsh?: { moduleFallback?: { targets?: Record<string, string> } } }
      if (manifest.name === '@deepseek-ai/cordis') {
        const target = Object.values(manifest.dsh?.moduleFallback?.targets ?? {})[0]
        return target === undefined ? realpathSync(dir) : cordisPackageDir(target)
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** Compare resolvable physical peers; a missing or unreadable peer has no verdict. */
function compareCordisCopies(dir: string): boolean | null {
  try {
    const installed = cordisPackageDir(createRequire(join(dir, 'package.json')).resolve('@deepseek-ai/cordis'))
    const host = cordisPackageDir(import.meta.resolve('@deepseek-ai/cordis'))
    return installed === undefined || host === undefined ? null : installed === host
  } catch {
    return null
  }
}
