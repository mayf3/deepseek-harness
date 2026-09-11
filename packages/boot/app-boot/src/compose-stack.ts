/**
 * Profile composition with row-id ownership in manifest order. A bundle with
 * duplicate ids is omitted whole and reported; conflicting user inserts are
 * omitted per row. Startup failure policy belongs to the application audit.
 * @module @deepseek-ai/dsh-app-boot/compose-stack
 */

import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { analyzeBundleLayer, type AnalyzedBundleLayer } from './external-bundles.ts'
import { visitPatchRows, visitRowTree } from './patch-rows.ts'
import type { ProfileLayer } from './profile.ts'

/** One user-owned patch list in the stack: the profile file, the home file, or a `--patch` overlay. */
export interface StackUserLayer {
  /** How diagnostics name the layer (a file path or the flag that supplied it). */
  readonly label: string
  /** The layer's patches, as parsed from disk. */
  readonly patches: PatchOptions[]
}

/** One row a layer could not mount because its id is already declared. */
export interface RowConflict {
  /** The id declared more than once. */
  readonly rowId: string
  /** The module the losing row named. */
  readonly moduleName: string
  /** The layer that lost: a bundle's package name or a user layer's label. */
  readonly layer: string
  /** The bundle that lost, when the loser is one; its whole layer is left out. */
  readonly packageName?: string
  /**
   * The layer that already declares the id: a bundle's package name or a user
   * layer's label, or the losing layer itself when it declares the id twice.
   */
  readonly declaredBy: string
  /** The reason as diagnostics and the plugin list state it, without the layer that lost. */
  readonly message: string
}

/** The stack as the root include should mount it, with what it left out. */
export interface ComposedStack {
  /** Patches in application order: bundle layers in manifest order, then the user layers as given. */
  readonly patches: PatchOptions[]
  /** The same patches per layer, labelled by package name or user-layer label; a skipped bundle has no entry. */
  readonly layers: StackUserLayer[]
  /** The bundle layer that owns each id a bundle layer introduces; rows user layers insert are not listed. */
  readonly owners: ReadonlyMap<string, ProfileLayer>
  /** Every row left out, in stack order. */
  readonly conflicts: RowConflict[]
  /** External bundles left out because a row id was already claimed or repeated. */
  readonly skippedBundles: string[]
  /**
   * Row ids the user layers disable with a literal `disabled: true`, as
   * composed; a `!!js` gate stays an expression node when read from disk, so
   * it is a condition of the composition, not a user decision.
   */
  readonly userDisabledRowIds: ReadonlySet<string>
}

/** Row-id ownership across the bundle layers: who owns each id, which bundles lost, and how the rest mount. */
export interface LayerOwnership {
  /** The layer that owns each id a bundle layer introduces. */
  readonly owners: Map<string, ProfileLayer>
  /** The conflicts of each bundle left out, by package name. */
  readonly skipped: Map<string, RowConflict[]>
  /** The analysis of each bundle layer that owns its ids, by package name; rendered once and mounted as is. */
  readonly composed: Map<string, AnalyzedBundleLayer>
}

/** One conflict with its message: the id's other declarer, or the losing layer itself declaring it twice. */
function rowConflict(fields: Omit<RowConflict, 'message'>): RowConflict {
  const id = JSON.stringify(fields.rowId)
  const message = fields.declaredBy === fields.layer
    ? `row ${id} is declared twice by ${fields.layer}`
    : `row ${id} is already declared by ${fields.declaredBy}`
  return { ...fields, message }
}

/** The ids one inserted row carries: its own and, for a group, its children's. */
function rowIds(row: EntryOptions): string[] {
  const ids: string[] = []
  visitRowTree(row, (entry) => {
    if (typeof entry.id === 'string') ids.push(entry.id)
  })
  return ids
}

/**
 * Claim bundle rows in manifest order. A layer that repeats an id or declares
 * an earlier layer's id is omitted whole. Restating a child in the same group
 * preserves its ownership; moving it to another group is a duplicate.
 * @param layers - the profile's bundle layers, in manifest order.
 * @returns row owners, rejected-bundle conflicts, and each accepted layer's analysis.
 */
export function claimLayerIds(layers: readonly ProfileLayer[]): LayerOwnership {
  const owners = new Map<string, ProfileLayer>()
  const skipped = new Map<string, RowConflict[]>()
  const composed = new Map<string, AnalyzedBundleLayer>()
  for (const layer of layers) {
    const { packageName } = layer
    const composition = analyzeBundleLayer(layer)
    const conflicts: RowConflict[] = composition.duplicates.map(({ rowId, moduleName }) => (
      rowConflict({ rowId, moduleName, layer: packageName, packageName, declaredBy: packageName })
    ))
    for (const [rowId, moduleName] of composition.rows) {
      const owner = owners.get(rowId)
      if (owner !== undefined) {
        conflicts.push(rowConflict({ rowId, moduleName, layer: packageName, packageName, declaredBy: owner.packageName }))
      }
    }
    if (conflicts.length > 0) {
      skipped.set(packageName, conflicts)
      continue
    }
    for (const id of composition.rows.keys()) owners.set(id, layer)
    composed.set(packageName, composition)
  }
  return { owners, skipped, composed }
}

/**
 * Compose the stack the root include mounts: every bundle layer that owns its
 * ids, in manifest order, then the user layers with any insert of an already
 * owned id dropped. Bundle patches are copied before assigning anonymous ids;
 * user patches remain shared input, so callers mount a detached execution copy.
 * @param layers - the profile's bundle layers, in manifest order.
 * @param userLayers - the user-owned layers, in application order.
 * @returns the patches to mount, the owner of every bundle id, the conflicts, the bundles left out, and the rows the user layers disable.
 */
export function composeProfileStack(
  layers: readonly ProfileLayer[], userLayers: readonly StackUserLayer[],
): ComposedStack {
  // Only anonymous bundle rows need an assigned id. The execution copy keeps
  // provenance available after loading without modifying author-owned patches.
  layers = layers.map((layer) => {
    const patches = structuredClone(layer.patches)
    let anonymous = 0
    visitPatchRows(patches, (row) => { row.id ||= `anonymous/${layer.packageName}/${String(anonymous++)}` })
    return { ...layer, patches }
  })
  const ownership = claimLayerIds(layers)
  const composedLayers: StackUserLayer[] = []
  const conflicts: RowConflict[] = []
  const skippedBundles: string[] = []
  for (const layer of layers) {
    const lost = ownership.skipped.get(layer.packageName)
    if (lost !== undefined) {
      conflicts.push(...lost)
      skippedBundles.push(layer.packageName)
      continue
    }
    composedLayers.push({ label: layer.packageName, patches: layer.patches })
  }
  const claimed = new Map<string, string>()
  for (const [id, layer] of ownership.owners) claimed.set(id, layer.packageName)
  const userDisabledRowIds = new Set<string>()
  for (const userLayer of userLayers) {
    const patches: PatchOptions[] = []
    for (const patch of userLayer.patches) {
      if (patch.insert === undefined) {
        if (patch.id !== undefined && patch.disabled === true) userDisabledRowIds.add(patch.id)
        patches.push(patch)
        continue
      }
      const kept: EntryOptions[] = []
      for (const row of patch.insert) {
        const ids = rowIds(row)
        const taken = ids.map(id => [id, claimed.get(id)] as const).find(([, owner]) => owner !== undefined)
        if (taken?.[1] !== undefined) {
          conflicts.push(rowConflict({ rowId: taken[0], moduleName: row.name, layer: userLayer.label, declaredBy: taken[1] }))
          continue
        }
        for (const id of ids) claimed.set(id, userLayer.label)
        kept.push(row)
      }
      if (kept.length === patch.insert.length) patches.push(patch)
      else if (kept.length > 0) patches.push({ ...patch, insert: kept })
    }
    composedLayers.push({ label: userLayer.label, patches })
  }
  return {
    patches: composedLayers.flatMap(layer => layer.patches),
    layers: composedLayers,
    owners: ownership.owners,
    conflicts,
    skippedBundles,
    userDisabledRowIds,
  }
}

/**
 * One diagnostic line for a conflict, as boot and the config dump print it.
 * @param conflict - the conflict to describe.
 * @returns the line, without a binary-name prefix.
 */
export function formatRowConflict(conflict: RowConflict): string {
  return conflict.packageName === undefined
    ? `${conflict.layer}: insert of ${conflict.moduleName} skipped — ${conflict.message}`
    : `bundle ${conflict.packageName} left out — ${conflict.message}`
}
