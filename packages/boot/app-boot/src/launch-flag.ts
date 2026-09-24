/** Strict boolean parsing for launcher-owned environment switches. */

/**
 * Resolve an optional binary environment switch, rejecting misspelled values.
 * @param name - environment variable used in configuration errors.
 * @param value - inherited environment value.
 * @param defaultValue - policy when the variable is absent.
 * @returns the resolved switch.
 */
export function resolveLaunchFlag(name: string, value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue
  if (value === '0') return false
  if (value === '1') return true
  throw new Error(`${name} must be 0 or 1`)
}
