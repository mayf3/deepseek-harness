/**
 * The profile patch stack composed with tree-wide row-id ownership. Entry ids
 * are unique per Loader tree, and the vendored group `create()` re-parents an
 * existing id instead of rejecting it, so a shared id namespace needs its
 * check before anything mounts: built-in and boot-staged layers claim their
 * ids first and a duplicate among or inside them fails loud; an external
 * bundle whose id is already claimed, or which declares one of its own ids
 * twice, is skipped whole and recorded as a conflict; a user layer's insert
 * of a claimed id drops that row and records it. One composition yields the
 * patches, the owner of every id, and the conflicts, and each optional
 * layer is analyzed once. Boot, live recomposition, and the config dump all
 * compose through here, so they agree.
 * @module @deepseek-ai/dsh-app-boot/compose-stack
 */

import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { analyzeBundleLayer, isOptionalRuntimeLayer, type AnalyzedBundleLayer } from './external-bundles.ts'
import { visitIdentifiedRows, visitPatchRows, visitRowTree } from './patch-rows.ts'
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
  /** The external bundle that lost, when the loser is one; its whole layer is left out. */
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

/** Row-id ownership across the bundle layers: who owns each id, which external bundles lost, and how the rest mount. */
export interface LayerOwnership {
  /** The layer that owns each id a bundle layer introduces. */
  readonly owners: Map<string, ProfileLayer>
  /** The conflicts of each external bundle left out, by package name. */
  readonly skipped: Map<string, RowConflict[]>
  /** The analysis of each optional layer that owns its ids, by package name; rendered once and mounted as is. */
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
 * Decide row-id ownership across the bundle layers. A layer introduces the
 * rows it inserts and the rows its config overrides set as a group's
 * children. Built-in and boot-staged layers claim first, in manifest order;
 * an id two of them declare, or one inserts twice, is a defect of the shipped
 * composition and throws, while a config override restating a row under the
 * group the same layer declared it in is that layer keeping its own child;
 * the same id twice in one config list, or set under another group, is
 * declared twice. Contained external layers then claim in manifest order,
 * each rendered once here; one whose id is already owned, or which declares
 * an id twice, is left out whole.
 * @param layers - the profile's bundle layers, in manifest order.
 * @returns the owner of every claimed id, the conflicts of each skipped bundle, and the composition of each mounted one.
 * @throws when two built-in or boot-staged layers declare the same id, or one of them declares an id twice.
 */
export function claimLayerIds(layers: readonly ProfileLayer[]): LayerOwnership {
  const owners = new Map<string, ProfileLayer>()
  const declaredUnder = new Map<string, string | undefined>()
  for (const layer of layers) {
    if (isOptionalRuntimeLayer(layer)) continue
    visitIdentifiedRows(layer.patches, ({ id, source, place, listed }) => {
      const owner = owners.get(id)
      if (owner === layer) {
        // Restating a row under the group that already holds it is the layer
        // keeping its child; inserting it again, listing it twice in one
        // config, or setting it under another group is declaring it twice.
        if (source === 'insert' || listed.has(id) || declaredUnder.get(id) !== place.target) {
          throw new Error(`row ${JSON.stringify(id)} is declared twice by ${layer.packageName}`)
        }
      } else if (owner !== undefined) {
        throw new Error(`row ${JSON.stringify(id)} is declared by both ${owner.packageName} and ${layer.packageName}`)
      } else {
        owners.set(id, layer)
        declaredUnder.set(id, place.target)
      }
    })
  }
  const skipped = new Map<string, RowConflict[]>()
  const composed = new Map<string, AnalyzedBundleLayer>()
  for (const layer of layers) {
    if (!isOptionalRuntimeLayer(layer)) continue
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
 * @param binName - the diagnostic prefix on a thrown built-in duplicate.
 * @param layers - the profile's bundle layers, in manifest order.
 * @param userLayers - the user-owned layers, in application order.
 * @returns the patches to mount, the owner of every bundle id, the conflicts, the bundles left out, and the rows the user layers disable.
 * @throws when two built-in or boot-staged layers declare the same id, or one of them declares an id twice.
 */
export function composeProfileStack(
  binName: string, layers: readonly ProfileLayer[], userLayers: readonly StackUserLayer[],
): ComposedStack {
  // Only anonymous bundle rows need an assigned id. The execution copy keeps
  // provenance available after loading without modifying author-owned patches.
  layers = layers.map((layer) => {
    const patches = structuredClone(layer.patches)
    let anonymous = 0
    visitPatchRows(patches, (row) => { row.id ||= `anonymous/${layer.packageName}/${String(anonymous++)}` })
    return { ...layer, patches }
  })
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
    const composition = ownership.composed.get(layer.packageName)
    composedLayers.push({ label: layer.packageName, patches: composition === undefined ? layer.patches : composition.patches })
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
