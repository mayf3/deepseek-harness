import { expect, it } from 'vitest'
import { resolveLaunchFlag } from '../src/launch-flag.ts'

it.each([true, false])('uses the configured absent-value default: %s', (fallback) => {
  expect(resolveLaunchFlag('FLAG', undefined, fallback)).toBe(fallback)
  expect(resolveLaunchFlag('FLAG', '0', fallback)).toBe(false)
  expect(resolveLaunchFlag('FLAG', '1', fallback)).toBe(true)
})
it.each(['', 'false', 'no', '2'])('rejects invalid binary flags: %s', (value) => {
  expect(() => resolveLaunchFlag('FLAG', value, true)).toThrow('FLAG must be 0 or 1')
})
