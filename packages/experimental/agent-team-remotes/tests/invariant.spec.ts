/** Package invariant registration for the Agent Teams Remote assembly. */

import { describe, expect, it, vi } from 'vitest'
import * as invariant from '../src/invariant.ts'

describe('Agent Teams Remote invariant', () => {
  it('reserves package ownership with an empty invariant installer', async () => {
    const register = vi.fn().mockReturnValue(() => {})
    const ctx = { invariants: { register } } as never

    const dispose = await invariant.apply(ctx)
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-agent-team-remotes', expect.any(Function))
    expect(() => { (register.mock.calls[0]![1] as () => void)() }).not.toThrow()
    expect(dispose).toBeTypeOf('function')
  })
})
