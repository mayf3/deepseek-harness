/**
 * Waits that end only when a lane budget below them is in force. Runs only
 * inside the Vitest child that scripts/lane-test-budget.spec.ts spawns.
 */
import { beforeEach, describe, expect, it } from 'vitest'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe('lane test budget fixture', () => {
  it('per-test budget', async () => {
    await sleep(600)
  })

  // Its own case budget stays above the wait so the poll budget, not the
  // per-test budget, is what ends the assertion.
  it('expect.poll budget', { timeout: 5_000 }, async () => {
    const start = Date.now()
    await expect.poll(() => Date.now() - start).toBeGreaterThan(500)
  })

  describe('hook budget', () => {
    beforeEach(async () => {
      await sleep(600)
    })

    it('runs after the hook', () => {})
  })
})
