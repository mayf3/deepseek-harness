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
  visit(row)
  if (row.group && Array.isArray(row.config)) {
    for (const child of row.config as EntryOptions[]) visitRowTree(child, visit)
  }
}

/**
 * Visit every row a patch list introduces, at any depth, in written order:
 * the rows a patch inserts, and the rows an id-targeted patch sets as a
 * group's `config`, which mount as that group's children the same way an
 * insert's do.
 * @param patches - the patch list.
 * @param visit - called once per row, with how the patch introduced it.
 */
export function visitPatchRows(patches: readonly PatchOptions[], visit: (row: EntryOptions, source: PatchRowSource) => void): void {
  for (const patch of patches) {
    if (patch.insert !== undefined) {
      for (const row of patch.insert) visitRowTree(row, (entry) => { visit(entry, 'insert') })
      continue
    }
    if (patch.id === undefined || !Array.isArray(patch.config)) continue
    for (const item of patch.config as unknown[]) {
      if (isRowLike(item)) visitRowTree(item, (entry) => { visit(entry, 'config') })
    }
  }
}
