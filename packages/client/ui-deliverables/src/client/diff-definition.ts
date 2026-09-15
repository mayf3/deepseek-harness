/**
 * What the `changes-diff` tab type IS: the right-Sidebar viewer of one listed
 * changed file's turn-start and turn-end comparison. It claims the
 * `dsh-resource://changes-diff/session/…` addresses the changed-files card
 * mints; the coordinates in the address identify the content, and the display
 * path they carry names the tab.
 */
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { parseChangesDiffAddress } from '../changes.ts'
import { basename } from '../presented.ts'

/** The tab kind this package owns. */
export const CHANGES_DIFF_KIND = 'changes-diff'

/** This implementation's identity in the tab system, and the key its body registers under. */
export const CHANGES_DIFF_ID = '@deepseek-ai/dsh-client-ui-deliverables'

/**
 * The comparison type's registry definition.
 * @returns the definition to register.
 */
export function changesDiffDefinition(): SidebarRightTabDefinition {
  return {
    id: CHANGES_DIFF_ID,
    kind: CHANGES_DIFF_KIND,
    patterns: ['dsh-resource://changes-diff/**'],
    priority: 'builtin',
    canOpen: address => parseChangesDiffAddress(address) !== undefined,
    title: (address) => {
      const display = parseChangesDiffAddress(address)?.display
      return display === undefined ? address : basename(display)
    },
  }
}
