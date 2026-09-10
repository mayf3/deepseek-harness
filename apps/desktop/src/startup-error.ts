/** Recovery guidance attached by the owner of a failed Desktop startup operation. */

/** Actions that can restore an unavailable Desktop backend. */
export type DesktopRecovery = 'restart' | 'reinstall' | 'plugins' | 'configuration'

/** An operation failure with recovery guidance independent of its diagnostic wording. */
export class DesktopStartupError extends Error {
  /**
   * @param recovery - Recovery supported by the failed operation.
   * @param cause - Original diagnostic, retained for troubleshooting.
   */
  constructor(readonly recovery: DesktopRecovery, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
  }
}

/**
 * Preserve diagnostics and recovery guidance when sending failures to a renderer.
 * @param error - Startup or runtime failure.
 * @returns Serializable error state; unclassified failures suggest restarting.
 */
export function desktopErrorState(error: unknown): {
  phase: 'error'
  message: string
  recovery: DesktopRecovery
} {
  const message = error instanceof AggregateError
    ? [error.message, ...error.errors.map(item => desktopErrorState(item).message)].join('\n')
    : error instanceof Error ? error.message : String(error)
  return { phase: 'error', message, recovery: error instanceof DesktopStartupError ? error.recovery : 'restart' }
}
