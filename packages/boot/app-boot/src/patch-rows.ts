/**
 * The one walk over the rows a patch list introduces. Composition, ownership,
 * the package probe, and patch loading all read those rows and their group
 * children; sharing the walk keeps them reading the same tree.
 * @module @deepseek-ai/dsh-app-boot/patch-rows
 */

import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'

/** How a patch introduced a row: inserted it, or set it as a group's `config`. */
export type PatchRowSource = 'insert' | 'config'

/**
 * Where a patch introduced a row. `target` is the id of the group the row is
 * declared under — the patch's target, or the enclosing group row for a nested
 * one — undefined for a root-level insert, and a private marker for a child of
 * a group without an id, which no later patch can address. `patch` is the
 * index of the patch in the list, so the same id twice in one config list can
 * be told from a restatement across patches.
 */
export interface PatchRowPlace {
  readonly target: string | undefined
  readonly patch: number
}

/** The target of rows nested in a group that declares no id: nothing can restate them, so nothing may match it. */
const ANONYMOUS_GROUP = '\u0000anonymous-group'

/** Whether a config item is a row: a plain object naming a module. */
function isRowLike(value: unknown): value is EntryOptions {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as { name?: unknown }).name === 'string'
}

/**
 * Visit one row and, for a group with a list config, each of its children,
 * parents before children, in written order.
 * @param row - the row.
 * @param visit - called once per row.
 */
export function visitRowTree(row: EntryOptions, visit: (row: EntryOptions) => void): void {
  visitPlacedRows(row, undefined, (entry) => { visit(entry) })
}

/** The walk behind {@link visitRowTree}, carrying the group each row is declared under. */
function visitPlacedRows(
  row: EntryOptions, target: string | undefined, visit: (row: EntryOptions, target: string | undefined) => void,
): void {
  visit(row, target)
  if (row.group && Array.isArray(row.config)) {
    const own = typeof row.id === 'string' ? row.id : ANONYMOUS_GROUP
    for (const child of row.config as EntryOptions[]) visitPlacedRows(child, own, visit)
  }
}

/**
 * Visit every row a patch list introduces, at any depth, in written order:
 * the rows a patch inserts, and the rows an id-targeted patch sets as a
 * group's `config`, which mount as that group's children the same way an
 * insert's do.
 * @param patches - the patch list.
 * @param visit - called once per row, with how the patch introduced it and where.
 */
export function visitPatchRows(
  patches: readonly PatchOptions[],
  visit: (row: EntryOptions, source: PatchRowSource, place: PatchRowPlace) => void,
): void {
  patches.forEach((patch, index) => {
    if (patch.insert !== undefined) {
      for (const row of patch.insert) visitPlacedRows(row, patch.id, (entry, target) => { visit(entry, 'insert', { target, patch: index }) })
      return
    }
    if (patch.id === undefined || !Array.isArray(patch.config)) return
    for (const item of patch.config as unknown[]) {
      if (isRowLike(item)) visitPlacedRows(item, patch.id, (entry, target) => { visit(entry, 'config', { target, patch: index }) })
    }
  })
}

/** One id-carrying row `visitIdentifiedRows` reports. */
export interface IdentifiedRow {
  /** The row's id. */
  id: string
  /** The row as the patch wrote it. */
  row: EntryOptions
  /** How the patch introduced the row. */
  source: PatchRowSource
  /** Where the row mounts. */
  place: PatchRowPlace
  /** The ids the same patch listed before this row. */
  listed: ReadonlySet<string>
}

/**
 * Visit every row with an id a patch list introduces, in written order, with
 * the ids the same patch listed before it: a config override lists the
 * children it keeps, and an id it lists twice would mount as a rejected
 * duplicate, which each caller reports in its own terms.
 * @param patches - the patch list.
 * @param visit - called once per row that carries an id.
 */
export function visitIdentifiedRows(patches: readonly PatchOptions[], visit: (visited: IdentifiedRow) => void): void {
  let listed = new Set<string>()
  let listIndex = -1
  visitPatchRows(patches, (row, source, place) => {
    if (typeof row.id !== 'string') return
    if (place.patch !== listIndex) {
      listIndex = place.patch
      listed = new Set()
    }
    visit({ id: row.id, row, source, place, listed })
    listed.add(row.id)
  })
}
