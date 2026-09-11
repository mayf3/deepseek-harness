/** Validate recorded workspace changes and address their native-open actions. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceChangedFile, WorkspaceChangesData } from '@deepseek-ai/dsh-workspace-changes/types'

/** Authenticated POST route for opening a changed file, or the changed files' common folder, on the Host desktop. */
export const CHANGES_OPEN_PATH = '/api/changes.open'

/**
 * Validate one changed-file record read from a Session log.
 * @param value - decoded durable data.
 * @returns whether the record carries a path, a display path, and line counts.
 */
export function isChangedFile(value: unknown): value is WorkspaceChangedFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { path, display, added, deleted, binary } = value as Record<string, unknown>
  return typeof path === 'string' && path.length > 0 && typeof display === 'string' && display.length > 0
    && Number.isSafeInteger(added) && Number.isSafeInteger(deleted) && (binary === undefined || binary === true)
}

/**
 * Validate a change summary before reading its turn or files.
 * @param value - decoded durable event data.
 * @returns whether the event identifies a turn, a complete file list, and the total count.
 */
export function isChangesData(value: unknown): value is WorkspaceChangesData {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { turn, files, total } = value as Record<string, unknown>
  return typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 1
    && Number.isSafeInteger(total) && Array.isArray(files) && files.every(isChangedFile)
}

/**
 * Build authenticated coordinates for a changed file or the changed files' common folder.
 * @param sessionId - owning Session.
 * @param seq - workspace/changes event sequence.
 * @param index - original index in the event's files array, or null for the common folder.
 * @returns same-origin action URL.
 */
export function changedFileUrl(sessionId: SessionId, seq: number, index: number | null): string {
  const query = new URLSearchParams({ sessionId, seq: String(seq) })
  if (index !== null) query.set('index', String(index))
  return `${CHANGES_OPEN_PATH}?${query}`
}
