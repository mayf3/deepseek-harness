import { describe, expect, it, vi } from 'vitest'
import type { JobAppendOptions, JobOutputSource } from '@deepseek-ai/dsh-jobs'
import { startPump } from '../src/pump.ts'

/** Record every append so pump behavior is observable without a registry. */
function sink() {
  const appends: { text: string; options?: JobAppendOptions }[] = []
  return {
    appends,
    append: (text: string, options?: JobAppendOptions) => { appends.push({ text, ...options !== undefined ? { options } : {} }) },
  }
}

/** A scripted source: each read() shifts the next scripted result. */
function scriptedSource(
  reads: { text: string; lossy?: boolean; spillPath?: string }[],
  channel?: 'stdout' | 'stderr',
): { source: JobOutputSource; offsets: number[] } {
  const offsets: number[] = []
  let offset = 0
  const source: JobOutputSource = {
    ...channel !== undefined ? { channel } : {},
    read(fromByte) {
      offsets.push(fromByte)
      const next = reads.shift() ?? { text: '' }
      offset += Buffer.byteLength(next.text, 'utf8')
      return {
        text: next.text,
        nextOffset: offset,
        lossy: next.lossy ?? false,
        ...next.spillPath !== undefined ? { spillPath: next.spillPath } : {},
      }
    },
  }
  return { source, offsets }
}

describe('startPump', () => {
  it('copies labeled deltas at the poll cadence and resumes each source at its own offset', async () => {
    vi.useFakeTimers()
    try {
      const { appends, append } = sink()
      let settle!: () => void
      const until = new Promise<void>((resolve) => { settle = resolve })
      const out = scriptedSource([{ text: 'a' }, { text: 'bc' }], 'stdout')
      const err = scriptedSource([{ text: '' }, { text: 'E' }], 'stderr')
      const pump = startPump([out.source, err.source], append, 50, until)

      await vi.advanceTimersByTimeAsync(50)
      settle()
      await pump.done
      expect(appends).toEqual([
        { text: 'a', options: { channel: 'stdout' } },
        { text: 'bc', options: { channel: 'stdout' } },
        { text: 'E', options: { channel: 'stderr' } },
      ])
      // Every read resumed from the previous nextOffset, never from a shared cursor.
      expect(out.offsets).toEqual([0, 1, 3])
      expect(err.offsets).toEqual([0, 0, 1])
      // Settlement cleared the pending poll timer instead of leaving it pending.
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks a lossy source read as a gap so observers see the discontinuity', async () => {
    const { appends, append } = sink()
    const { source } = scriptedSource([{ text: 'tail', lossy: true }])
    await startPump([source], append, 1, Promise.resolve()).done
    expect(appends).toEqual([{ text: 'tail', options: { gapBefore: true } }])
  })

  it("names the source's spill file on a lossy read and ignores one on a clean read", async () => {
    const { appends, append } = sink()
    const { source } = scriptedSource([
      { text: 'tail', lossy: true, spillPath: '/spill/out.log' },
      { text: 'more', spillPath: '/spill/out.log' },
    ], 'stdout')
    await startPump([source], append, 1, Promise.resolve()).done
    expect(appends).toEqual([
      { text: 'tail', options: { channel: 'stdout', gapBefore: true, spillPath: '/spill/out.log' } },
      { text: 'more', options: { channel: 'stdout' } },
    ])
  })

  it('treats a rejected settlement as settlement and still drains the final bytes', async () => {
    const { appends, append } = sink()
    const { source } = scriptedSource([{ text: 'last' }])
    await startPump([source], append, 1, Promise.reject(new Error('producer broke'))).done
    expect(appends).toEqual([{ text: 'last' }])
  })

  it('subscribes to the settlement once and holds one poll timer however long the job runs', async () => {
    vi.useFakeTimers()
    try {
      const { append } = sink()
      let subscriptions = 0
      let settle!: () => void
      const settled = new Promise<void>((resolve) => { settle = resolve })
      const counting = (promise: Promise<unknown>): Promise<unknown> => ({
        then(onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
          subscriptions += 1
          return counting(promise.then(onFulfilled, onRejected))
        },
      }) as unknown as Promise<unknown>
      const { source, offsets } = scriptedSource([])
      const pump = startPump([source], append, 50, counting(settled))

      const rounds = 10_000
      await vi.advanceTimersByTimeAsync(50 * rounds)
      expect(offsets).toHaveLength(rounds + 1)
      expect(subscriptions).toBeLessThanOrEqual(2)
      expect(vi.getTimerCount()).toBe(1)

      settle()
      await pump.done
      expect(offsets).toHaveLength(rounds + 2)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a non-positive poll interval before touching any source', () => {
    const { append } = sink()
    expect(() => startPump([], append, 0, Promise.resolve())).toThrow(/invalid pump pollMs/)
  })
})
