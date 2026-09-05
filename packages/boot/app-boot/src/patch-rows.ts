/**
 * The one walk over the rows a patch list inserts. Composition, ownership,
 * the package probe, and patch loading all read inserted rows and their
 * group children; sharing the walk keeps them reading the same tree.
 * @module @deepseek-ai/dsh-app-boot/patch-rows
 */

import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'

/**
 * Visit one inserted row and, for a group with a list config, each of its
 * children, parents before children, in written order.
 * @param row - the inserted row.
 * @param visit - called once per row.
 */
export function visitRowTree(row: EntryOptions, visit: (row: EntryOptions) => void): void {
  visit(row)
  if (row.group && Array.isArray(row.config)) {
    for (const child of row.config as EntryOptions[]) visitRowTree(child, visit)
  }
}

/**
 * Visit every row a patch list inserts, at any depth, in written order.
 * Id-targeted patches insert nothing and are skipped.
 * @param patches - the patch list.
 * @param visit - called once per inserted row.
 */
export function visitInsertedRows(patches: readonly PatchOptions[], visit: (row: EntryOptions) => void): void {
  for (const patch of patches) {
    for (const row of patch.insert ?? []) visitRowTree(row, visit)
  }
}
