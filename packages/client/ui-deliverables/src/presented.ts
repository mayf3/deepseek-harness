/** Validate durable delivery references and address their Web downloads. */
import type { PresentedFile } from '@deepseek-ai/dsh-tool-present/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'

/** Authenticated route for saved file bytes. */
export const PRESENT_DOWNLOAD_PATH = '/api/present.download'

/**
 * Validate a saved delivery read from a Session log.
 * @param value - decoded durable data.
 * @returns whether the reference contains the fields used for display and downloads.
 */
export function isPresentedFile(value: unknown): value is PresentedFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { path, name, bytes, attachmentId, description } = value as Record<string, unknown>
  return typeof path === 'string' && path.trim().length > 0
    && typeof name === 'string' && name.trim().length > 0
    && typeof attachmentId === 'string' && attachmentId.length > 0
    && typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes >= 0
    && (description === undefined || typeof description === 'string')
}

/**
 * Build an authenticated download coordinate for a saved delivery.
 * @param sessionId - owning Session.
 * @param seq - deliverables/presented event sequence.
 * @param index - original index in the event's files array.
 * @returns same-origin download URL.
 */
export function presentedFileUrl(sessionId: SessionId, seq: number, index: number): string {
  return `${PRESENT_DOWNLOAD_PATH}?${new URLSearchParams({ sessionId, seq: String(seq), index: String(index) })}`
}

/**
 * Validate a delivery event before reading its turn or saved references.
 * @param value - decoded durable event data.
 * @returns whether the event identifies a turn, call, and file-reference list.
 */
export function isPresentedData(value: unknown): value is { turn: number; callId: ToolCallId; files: unknown[] } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { turn, callId, files } = value as Record<string, unknown>
  return typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 1
    && typeof callId === 'string' && callId.length > 0 && Array.isArray(files)
}

/**
 * Trailing path segment, the part that identifies the file at a glance.
 * @param path - Slash- or backslash-separated path.
 * @returns The final segment, or the whole string when separator-free.
 */
export function basename(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at === -1 ? path : path.slice(at + 1)
}
