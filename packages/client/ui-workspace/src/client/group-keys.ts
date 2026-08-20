/** Group-section key prefix used by the list view, board orders, and persisted expansion state. */
export const GROUP_SECTION_PREFIX = 'group:'

/** Group-section key for sessions without a user-managed group. */
export const UNASSIGNED_GROUP_KEY = 'group:\u0000unassigned'

/**
 * Resolve one user group to its persisted order/expansion account key.
 * @param group - user group name; undefined means Unassigned.
 * @returns stable account key shared by list and board views.
 */
export function groupAccountKey(group: string | undefined): string {
  return group === undefined ? UNASSIGNED_GROUP_KEY : GROUP_SECTION_PREFIX + group
}
