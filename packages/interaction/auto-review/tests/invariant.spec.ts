import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as AutoReviewInvariant from '@deepseek-ai/dsh-auto-review/invariant'

describe('auto-review invariant companion', () => {
  it('reserves and releases the package registration without runtime state', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(AutoReviewInvariant)
    expect(() => ctx.invariants.register('@deepseek-ai/dsh-auto-review', () => {}))
      .toThrow(/already registered/)
    await fiber.dispose()
    const dispose = ctx.invariants.register('@deepseek-ai/dsh-auto-review', () => {})
    dispose()
    await ctx.fiber.dispose()
  })
})
