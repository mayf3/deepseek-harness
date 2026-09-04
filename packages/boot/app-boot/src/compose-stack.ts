/**
 * The profile patch stack composed with tree-wide row-id ownership. Entry ids
 * are unique per Loader tree, and the vendored group `create()` re-parents an
 * existing id instead of rejecting it, so a shared id namespace needs its
 * check before anything mounts: built-in and boot-staged layers claim their
 * ids first and a duplicate among them fails loud; an external bundle whose
 * id is already claimed is skipped whole and recorded as a conflict; a user
 * layer's insert of a claimed id drops that row and records it. Boot, live
 * recomposition, and the config dump all compose through here, so they agree.
 * @module @deepseek-ai/dsh-app-boot/compose-stack
 */

import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { bundleLayerPatches, composeExternalLayer, isContainedLayer } from './external-bundles.ts'
import type { ProfileLayer } from './profile.ts'

/** One user-owned patch list in the stack: the profile file, the home file, or a `--patch` overlay. */
export interface StackUserLayer {
  /** How diagnostics name the layer (a file path or the flag that supplied it). */
  readonly label: string
  /** The layer's patches, as parsed from disk. */
  readonly patches: PatchOptions[]
}

/** One row a layer could not mount because another layer already declares its id. */
export interface RowConflict {
  /** The id both layers declare. */
  readonly rowId: string
  /** The module the losing row named. */
  readonly moduleName: string
  /** The layer that lost: a bundle's package name or a user layer's label. */
  readonly layer: string
  /** The external bundle that lost, when the loser is one; its whole layer is left out. */
  readonly packageName?: string
  /** The layer that owns the id: a bundle's package name or a user layer's label. */
  readonly declaredBy: string
}

/** The stack as the root include should mount it, with what it left out. */
export interface ComposedStack {
  /** Patches in application order: bundle layers in manifest order, then the user layers as given. */
  readonly patches: PatchOptions[]
  /** The same patches per layer, labelled by package name or user-layer label; a skipped bundle has no entry. */
  readonly layers: StackUserLayer[]
  /** Every row left out, in stack order. */
  readonly conflicts: RowConflict[]
  /** External bundles left out because a row id was already claimed. */
  readonly skippedBundles: string[]
}

/** Row-id ownership across the bundle layers: who owns each id, and which external bundles lost. */
export interface LayerOwnership {
  /** The layer that owns each id a bundle layer introduces. */
  readonly owners: Map<string, ProfileLayer>
  /** The conflicts of each external bundle left out, by package name. */
  readonly skipped: Map<string, RowConflict[]>
}

/** Every `(id, module)` a patch list inserts, recursing into inserted groups. */
function insertedRows(patches: readonly PatchOptions[]): Map<string, string> {
  const rows = new Map<string, string>()
  const visit = (row: EntryOptions): void => {
    if (typeof row.id === 'string') rows.set(row.id, row.name)
    if (row.group && Array.isArray(row.config)) (row.config as EntryOptions[]).forEach(visit)
  }
  for (const patch of patches) patch.insert?.forEach(visit)
  return rows
}

/** The ids one inserted row carries: its own and, for a group, its children's. */
function rowIds(row: EntryOptions): string[] {
  const ids: string[] = []
  const visit = (entry: EntryOptions): void => {
    if (typeof entry.id === 'string') ids.push(entry.id)
    if (entry.group && Array.isArray(entry.config)) (entry.config as EntryOptions[]).forEach(visit)
  }
  visit(row)
  return ids
}

/**
 * Decide row-id ownership across the bundle layers. Built-in and boot-staged
 * layers claim first, in manifest order; a duplicate among them is a defect
 * of the shipped composition and throws. Contained external layers then claim
 * in manifest order, and one whose id is already owned is left out whole.
 * @param layers - the profile's bundle layers, in manifest order.
 * @returns the owner of every claimed id and the conflicts of each skipped bundle.
 * @throws when two built-in or boot-staged layers declare the same id.
 */
export function claimLayerIds(layers: readonly ProfileLayer[]): LayerOwnership {
  const owners = new Map<string, ProfileLayer>()
  for (const layer of layers) {
    if (isContainedLayer(layer)) continue
    for (const id of insertedRows(layer.patches).keys()) {
      const owner = owners.get(id)
      if (owner !== undefined) {
        throw new Error(`row ${JSON.stringify(id)} is declared by both ${owner.packageName} and ${layer.packageName}`)
      }
      owners.set(id, layer)
    }
  }
  const skipped = new Map<string, RowConflict[]>()
  for (const layer of layers) {
    if (!isContainedLayer(layer)) continue
    const { rows } = composeExternalLayer(layer)
    const conflicts: RowConflict[] = []
    for (const [rowId, moduleName] of rows) {
      const owner = owners.get(rowId)
      if (owner === undefined) continue
      conflicts.push({ rowId, moduleName, layer: layer.packageName, packageName: layer.packageName, declaredBy: owner.packageName })
    }
    if (conflicts.length > 0) {
      skipped.set(layer.packageName, conflicts)
      continue
    }
    for (const id of rows.keys()) owners.set(id, layer)
  }
  return { owners, skipped }
}

/**
 * Compose the stack the root include mounts: every bundle layer that owns its
 * ids, in manifest order, then the user layers with any insert of an already
 * owned id dropped. Patches are passed by reference; callers that mount them
 * clone, because the include pushes inserted rows into the tree as they are.
 * @param binName - the diagnostic prefix on a thrown built-in duplicate.
 * @param layers - the profile's bundle layers, in manifest order.
 * @param userLayers - the user-owned layers, in application order.
 * @returns the patches to mount, the conflicts, and the bundles left out.
 * @throws when two built-in or boot-staged layers declare the same id.
 */
export function composeProfileStack(
  binName: string, layers: readonly ProfileLayer[], userLayers: readonly StackUserLayer[],
): ComposedStack {
  let ownership: LayerOwnership
  try {
    ownership = claimLayerIds(layers)
  } catch (error) {
    throw new Error(`${binName}: ${(error as Error).message}`)
  }
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
    composedLayers.push({ label: layer.packageName, patches: bundleLayerPatches(layer) })
  }
  const claimed = new Map<string, string>()
  for (const [id, layer] of ownership.owners) claimed.set(id, layer.packageName)
  for (const userLayer of userLayers) {
    const patches: PatchOptions[] = []
    for (const patch of userLayer.patches) {
      if (patch.insert === undefined) {
        patches.push(patch)
        continue
      }
      const kept: EntryOptions[] = []
      for (const row of patch.insert) {
        const ids = rowIds(row)
        const taken = ids.map(id => [id, claimed.get(id)] as const).find(([, owner]) => owner !== undefined)
        if (taken?.[1] !== undefined) {
          conflicts.push({ rowId: taken[0], moduleName: row.name, layer: userLayer.label, declaredBy: taken[1] })
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
  return { patches: composedLayers.flatMap(layer => layer.patches), layers: composedLayers, conflicts, skippedBundles }
}

/**
 * One diagnostic line for a conflict, as boot and the config dump print it.
 * @param conflict - the conflict to describe.
 * @returns the line, without a binary-name prefix.
 */
export function formatRowConflict(conflict: RowConflict): string {
  const owner = `row ${JSON.stringify(conflict.rowId)} is already declared by ${conflict.declaredBy}`
  return conflict.packageName === undefined
    ? `${conflict.layer}: insert of ${conflict.moduleName} skipped — ${owner}`
    : `bundle ${conflict.packageName} left out — ${owner}`
}
