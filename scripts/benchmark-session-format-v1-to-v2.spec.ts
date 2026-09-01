import { describe, expect, it } from 'vitest'
import {
  ACCEPTANCE_DEFAULTS,
  SMOKE_DEFAULTS,
  parseOptions,
  percentile,
} from './benchmark-session-format-v1-to-v2.ts'

describe('v2 performance acceptance options', () => {
  it('pins the full acceptance and non-gating smoke specifications', () => {
    expect(parseOptions([])).toEqual({
      ...ACCEPTANCE_DEFAULTS,
      smoke: false,
      help: false,
    })
    expect(parseOptions(['--smoke'])).toEqual({
      ...SMOKE_DEFAULTS,
      smoke: true,
      help: false,
    })
  })

  it('accepts split and equals-form overrides independently of option order', () => {
    expect(parseOptions([
      '--samples=9',
      '--smoke',
      '--runs', '2',
      '--warmups=0',
      '--threshold-percent', '4',
    ])).toEqual({
      runs: 2,
      warmups: 0,
      samples: 9,
      thresholdPercent: 4,
      smoke: true,
      help: false,
    })
  })

  it.each([
    [['--unknown'], /unknown benchmark option/],
    [['--runs'], /requires a numeric value/],
    [['--runs', '0'], /runs must be positive/],
    [['--samples', '-1'], /samples must be a non-negative safe integer/],
    [['--threshold-percent', '1.5'], /threshold-percent must be a non-negative safe integer/],
  ] as const)('rejects invalid options %j', (arguments_, expected) => {
    expect(() => parseOptions(arguments_)).toThrow(expected)
  })
})

describe('v2 performance acceptance statistics', () => {
  it('uses the PR3 discrete percentile estimator without mutating input', () => {
    const values = [4, 1, 3, 2]
    expect(percentile(values, 0)).toBe(1)
    expect(percentile(values, 0.5)).toBe(3)
    expect(percentile(values, 0.95)).toBe(4)
    expect(percentile(values, 1)).toBe(4)
    expect(values).toEqual([4, 1, 3, 2])
  })

  it('rejects empty samples and invalid fractions', () => {
    expect(() => percentile([], 0.5)).toThrow(/at least one sample/)
    expect(() => percentile([1], -0.1)).toThrow(/between zero and one/)
    expect(() => percentile([1], 1.1)).toThrow(/between zero and one/)
    expect(() => percentile([1], Number.NaN)).toThrow(/between zero and one/)
  })
})
