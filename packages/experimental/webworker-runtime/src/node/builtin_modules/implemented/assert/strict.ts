/** Truthiness assertions for Worker modules importing `node:assert/strict`. */

/**
 * Require a truthy value; falsy values throw `ERR_ASSERTION` or the supplied Error.
 * @param value - Value to test.
 * @param message - Failure message or Error to throw unchanged; omitted messages use generic text.
 */
export function ok(value: unknown, message?: string | Error): asserts value {
  if (value) return
  if (message instanceof Error) throw message
  throw Object.assign(new Error(message ?? 'The expression evaluated to a falsy value.'), {
    name: 'AssertionError',
    code: 'ERR_ASSERTION',
    actual: value,
    expected: true,
    operator: '==',
    generatedMessage: message === undefined,
  })
}

/** CommonJS interop marker for lowered ESM default imports. */
export const __esModule = true

const assert: typeof ok & { ok: typeof ok } = Object.assign(ok, { ok })

/** Callable truthiness assertion with the identical `ok` method; other assertion APIs are absent. */
export default assert
