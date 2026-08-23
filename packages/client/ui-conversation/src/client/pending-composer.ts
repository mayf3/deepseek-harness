/** Shared settlement mechanics for composer takeovers backed by a pending waterfall. */

/**
 * Run one pending composer settlement and preserve non-Error rejection causes.
 * @param settle - synchronous Promise resolver or rejector invocation.
 * @param failureMessage - message used when the resolver throws a non-Error value.
 * @returns completion or a rejection carrying the original failure.
 */
export function settlePendingComposer(settle: () => void, failureMessage: string): Promise<void> {
  try {
    settle()
    return Promise.resolve()
  } catch (error) {
    return Promise.reject(error instanceof Error
      ? error
      : new Error(failureMessage, { cause: error }))
  }
}
