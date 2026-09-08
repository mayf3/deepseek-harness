import { describe, expect, it } from 'vitest'
import { requestReviewSmokeEnabled } from '../src/request-review-smoke.ts'

describe('requestReviewSmokeEnabled', () => {
  it.each([
    ['enabled', true],
    [' ENABLED ', true],
    ['disabled', false],
    [undefined, false],
  ] as const)('normalizes %s to %s', (value, expected) => {
    expect(requestReviewSmokeEnabled(value)).toBe(expected)
  })
})
