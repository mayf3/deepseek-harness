import { describe, expect, it } from 'vitest'
import { detachResidual } from '../src/index.ts'

describe('detachResidual — fd-3 residual detachment', () => {
  it('returns a copy that does NOT share the source frame allocation', () => {
    // Simulate the data handler's state: one large joined frame from
    // Buffer.concat, sliced past its newline to leave a small residual VIEW.
    const joined = Buffer.alloc(1024 * 1024, 0x61) // 1 MiB backing allocation
    joined[512] = 0x0a // a newline partway through
    const residual = joined.subarray(513) // a view onto `joined`'s backing store

    // Before the fix the handler carried this view forward verbatim, pinning the
    // whole 1 MiB `joined` allocation behind a residual that reports far fewer
    // bytes. A right-sized copy must not point back into `joined`.
    const [carried] = detachResidual(residual)

    expect(carried).toBeDefined()
    expect(carried!.length).toBe(residual.length)
    expect(carried!.equals(residual)).toBe(true)
    // The copy's backing store is its own, sized to its content — not the 1 MiB
    // frame. A subarray view would report the source's full byteLength here.
    expect(carried!.buffer.byteLength).toBe(carried!.length)
    expect(carried!.buffer).not.toBe(joined.buffer)
  })

  it('carries nothing forward for an empty residual', () => {
    expect(detachResidual(Buffer.alloc(0))).toEqual([])
  })
})
