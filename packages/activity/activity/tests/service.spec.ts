import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import ActivityRegistry, { ActivityId, pumpActivityOutput } from '@deepseek-ai/dsh-activity'
import type { ActivityAppendOptions, ActivityHandle, ActivityPumpSource, ActivitySnapshot } from '@deepseek-ai/dsh-activity'

/** Record every append so pump behavior is observable without a registry. */
function recordingHandle(): { handle: ActivityHandle; appends: { text: string; options?: ActivityAppendOptions }[] } {
  const appends: { text: string; options?: ActivityAppendOptions }[] = []
  const handle: ActivityHandle = {
    id: ActivityId('bash-1'),
    append(text, options) { appends.push({ text, ...options !== undefined ? { options } : {} }) },
    updateDetail() {},
    end() {},
  }
  return { handle, appends }
}

/** A scripted source: each read() shifts the next scripted result. */
function scriptedSource(
  reads: { text: string; lossy?: boolean }[],
  channel?: 'stdout' | 'stderr',
): { source: ActivityPumpSource; offsets: number[] } {
  const offsets: number[] = []
  let offset = 0
  const source: ActivityPumpSource = {
    ...channel !== undefined ? { channel } : {},
    read(fromByte) {
      offsets.push(fromByte)
      const next = reads.shift() ?? { text: '' }
      offset += Buffer.byteLength(next.text, 'utf8')
      return { text: next.text, nextOffset: offset, lossy: next.lossy ?? false }
    },
  }
  return { source, offsets }
}

describe('ActivityRegistry seam', () => {
  it('refuses to mount the abstract Service Definition directly', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(ActivityRegistry as unknown as () => void))
      .rejects.toThrow(/load an implementation such as @deepseek-ai\/dsh-activity-local/)
  })

  it('preserves the SessionId brand on public owner snapshots', () => {
    expectTypeOf<ActivitySnapshot['ownerSession']>().toEqualTypeOf<SessionId | undefined>()
  })
})

describe('pumpActivityOutput', () => {
  it('rejects a non-positive poll interval before touching any source', async () => {
    const { handle } = recordingHandle()
    await expect(pumpActivityOutput(handle, [], { pollMs: 0, done: Promise.resolve() }))
      .rejects.toThrow(/invalid pump pollMs/)
  })

  it('copies labeled deltas at the poll cadence and resumes each source at its own offset', async () => {
    vi.useFakeTimers()
    try {
      const { handle, appends } = recordingHandle()
      let settle!: () => void
      const done = new Promise<void>((resolve) => { settle = resolve })
      const out = scriptedSource([{ text: 'a' }, { text: 'bc' }], 'stdout')
      const err = scriptedSource([{ text: '' }, { text: 'E' }], 'stderr')
      const pump = pumpActivityOutput(handle, [out.source, err.source], { pollMs: 50, done })

      await vi.advanceTimersByTimeAsync(50)
      settle()
      await pump
      expect(appends).toEqual([
        { text: 'a', options: { channel: 'stdout' } },
        { text: 'bc', options: { channel: 'stdout' } },
        { text: 'E', options: { channel: 'stderr' } },
      ])
      // Every read resumed from the previous nextOffset, never from a shared cursor.
      expect(out.offsets).toEqual([0, 1, 3])
      expect(err.offsets).toEqual([0, 0, 1])
      // Settlement cleared the raced poll timer instead of leaving it pending.
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks a lossy source read as a gap so observers see the discontinuity', async () => {
    const { handle, appends } = recordingHandle()
    const { source } = scriptedSource([{ text: 'tail', lossy: true }])
    await pumpActivityOutput(handle, [source], { pollMs: 1, done: Promise.resolve() })
    expect(appends).toEqual([{ text: 'tail', options: { gapBefore: true } }])
  })

  it('treats a rejected done as settlement and still drains the final bytes', async () => {
    const { handle, appends } = recordingHandle()
    const { source } = scriptedSource([{ text: 'last' }])
    await pumpActivityOutput(handle, [source], { pollMs: 1, done: Promise.reject(new Error('producer broke')) })
    expect(appends).toEqual([{ text: 'last' }])
  })
})
