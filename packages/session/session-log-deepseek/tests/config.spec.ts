import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('session-log upload configuration', () => {
  it.each([
    { lane: 'ordinary process', vitest: undefined, snapshot: undefined, enabled: true },
    { lane: 'Vitest', vitest: 'true', snapshot: undefined, enabled: false },
    { lane: 'snapshot process', vitest: undefined, snapshot: '1', enabled: false },
    { lane: 'Vitest snapshot', vitest: 'true', snapshot: '1', enabled: false },
    { lane: 'empty Vitest marker', vitest: '', snapshot: undefined, enabled: false },
    { lane: 'empty snapshot marker', vitest: undefined, snapshot: '', enabled: false },
  ])('defaults upload for $lane and honors explicit overrides', async ({ vitest, snapshot, enabled }) => {
    vi.stubEnv('VITEST', vitest)
    vi.stubEnv('DSH_SNAPSHOT', snapshot)
    try {
      // The schema captures the process environment when its module loads.
      vi.resetModules()
      const { Config } = await import('../src/index.ts')
      expect(Config({}).enabled).toBe(enabled)
      expect(Config({ enabled: true }).enabled).toBe(true)
      expect(Config({ enabled: false }).enabled).toBe(false)
    } finally {
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })
})
