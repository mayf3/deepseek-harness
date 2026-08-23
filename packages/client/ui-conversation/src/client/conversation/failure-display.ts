/** Display-safe failure fields retained by locale-independent projections. */
export interface DisplayFailure {
  /** Stable provider failure code used for localized known-error copy. */
  code?: string
  /** Sanitized provider message; empty when the code owns the display copy. */
  message: string
}

/**
 * Convert a durable failure into locale-independent fields safe for GUI projections.
 * @param failure - Failure value preserved by the session event.
 * @returns Sanitized message and optional stable provider code.
 */
export function displayFailure(failure: unknown): DisplayFailure {
  if (failure === null || typeof failure !== 'object') return { message: String(failure) }
  const record = failure as { code?: unknown; message?: unknown }
  const code = typeof record.code === 'string' ? record.code : undefined
  // Provider AUTH messages may echo a masked or partially preserved credential.
  // Keep the raw diagnostic in the session log, but never project it into UI state.
  if (code === 'AUTH') return { code, message: '' }
  return {
    ...(code === undefined ? {} : { code }),
    message: typeof record.message === 'string' ? record.message : JSON.stringify(failure),
  }
}
