/** Validate workspace-change records that cross the Host route and address their summary and native-open actions. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceChangedFile, WorkspaceChangesSummary } from '@deepseek-ai/dsh-workspace-changes/types'

/** Authenticated GET route serving one announced change summary while its Session lives. */
export const CHANGED_FILES_PATH = '/api/changes.summary'

/** Authenticated POST route for opening a changed file, or the changed files' common folder, on the Host desktop. */
export const CHANGES_OPEN_PATH = '/api/changes.open'

/** The summary fields the route serves; the Host keeps the working directory and snapshot ids to itself. */
export type ChangesSummary = Pick<WorkspaceChangesSummary, 'turn' | 'files' | 'total' | 'added' | 'deleted'>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate one changed-file record read from the summary route.
 * @param value - decoded JSON.
 * @returns whether the record carries a path, a display path, and line counts.
 */
export function isChangedFile(value: unknown): value is WorkspaceChangedFile {
  if (!isRecord(value)) return false
  const { path, display, added, deleted, binary } = value
  return typeof path === 'string' && path.length > 0 && typeof display === 'string' && display.length > 0
    && Number.isSafeInteger(added) && Number.isSafeInteger(deleted) && (binary === undefined || binary === true)
}

/**
 * Validate a summary read from the summary route.
 * @param value - decoded JSON.
 * @returns whether the value identifies a turn, a complete file list, the total count, and the line totals.
 */
export function isChangesSummary(value: unknown): value is ChangesSummary {
  if (!isRecord(value)) return false
  const { turn, files, total, added, deleted } = value
  return Number.isSafeInteger(turn) && (turn as number) >= 1 && Number.isSafeInteger(total)
    && Number.isSafeInteger(added) && Number.isSafeInteger(deleted)
    && Array.isArray(files) && files.every(isChangedFile)
}

/**
 * Validate the `workspace/changes` event data read from a Session log.
 * @param value - decoded durable event data.
 * @returns whether the event names a turn.
 */
export function isChangesEvent(value: unknown): value is { turn: number } {
  return isRecord(value) && Number.isSafeInteger(value.turn) && (value.turn as number) >= 1
}

/**
 * Build authenticated coordinates for the summary one `workspace/changes` event announced.
 * @param sessionId - owning Session.
 * @param seq - event sequence.
 * @returns same-origin summary URL.
 */
export function changesSummaryUrl(sessionId: SessionId, seq: number): string {
  return `${CHANGED_FILES_PATH}?${new URLSearchParams({ sessionId, seq: String(seq) })}`
}

/**
 * Build authenticated coordinates for a changed file or the changed files' common folder.
 * @param sessionId - owning Session.
 * @param seq - workspace/changes event sequence.
 * @param index - original index in the summary's files array, or null for the common folder.
 * @returns same-origin action URL.
 */
export function changedFileUrl(sessionId: SessionId, seq: number, index: number | null): string {
  const query = new URLSearchParams({ sessionId, seq: String(seq) })
  if (index !== null) query.set('index', String(index))
  return `${CHANGES_OPEN_PATH}?${query}`
}
