/** Persist in-process and Apple-tool phases in the packaging journal. */
/**
 * Record a phase outcome and redacted nested failure details.
 * @param directory Existing run directory; undefined retains unrecorded callers.
 * @param stage Public phase label, never credentials.
 * @param action Work that settles all owned activity before returning.
 * @param secrets Credential values removed from errors.
 * @returns Action result; logging failures also reject the phase.
 */
export function packagingStep<T>(directory: string | undefined, stage: string, action: () => Promise<T>, secrets?: readonly string[]): Promise<T>
