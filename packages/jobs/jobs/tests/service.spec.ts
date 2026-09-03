import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { JobId, JobRegistry, pumpJobOutput } from '@deepseek-ai/dsh-jobs'
import type {
  JobAppendOptions, JobDoneListener, JobHooks, JobOutputListener, JobPumpSource, JobRead, JobRecordRead,
  JobSnapshot, JobStart, JobsChangedListener, PlainJobStart, RecordingJob, RecordingJobStart,
} from '@deepseek-ai/dsh-jobs'

/**
 * Minimal concrete registry: one canned record. The Service Definition owns the contract
 * only (ids, snapshots, authorization-shaped signatures); the registry
 * behavior suite lives with `@deepseek-ai/dsh-jobs-local`.
 */
class StubJobRegistry extends JobRegistry {
  snapshotOf(id: JobId): JobSnapshot {
    return {
      id,
      kind: 'bash',
      label: 'sleep 60',
      status: 'running',
      startedAt: 0,
      reported: false,
    }
  }

  start(spec: JobStart): JobId {
    const id = JobId(`${spec.kind}-1`)
    spec.run({ id, append() {}, updateDetail() {} })
    return id
  }

  list(): JobSnapshot[] {
    return [this.snapshotOf(JobId('bash-1'))]
  }

  get(id: JobId): JobSnapshot {
    return this.snapshotOf(id)
  }

  read(id: JobId): JobRead {
    return { text: '', snapshot: this.snapshotOf(id) }
  }

  kill(): 'requested' | 'already-finished' {
    return 'requested'
  }

  wait(id: JobId, _timeoutMs: number, _caller?: Agent, _signal?: AbortSignal): Promise<JobSnapshot> {
    return Promise.resolve(this.snapshotOf(id))
  }

  onJobDone(_listener: JobDoneListener): () => void {
    return () => {}
  }

  onJobsChanged(_listener: JobsChangedListener): () => void {
    return () => {}
  }

  readRecord(_id: JobId, from: number): JobRecordRead {
    return { chunks: [], next: from, lossy: false }
  }

  onOutput(_listener: JobOutputListener): () => void {
    return () => {}
  }

  attachController(_name: string): () => void {
    return () => {}
  }
}

/** Compile-time probe: does the producer face `Face` carry `append`? */
type HasAppend<Face> = 'append' extends keyof Face ? true : false

describe('JobStart producer faces', () => {
  it('hands append only to a start that declares a record', () => {
    const hooks: JobHooks = { cancel() {}, done: new Promise(() => {}) }
    // The literal's `record` discriminant selects the face `run` receives.
    const plain: JobStart = {
      kind: 'bash',
      label: 'no record',
      run: (job) => {
        job.updateDetail('works for every job')
        return hooks
      },
    }
    const recording: JobStart = {
      kind: 'bash',
      label: 'record',
      record: true,
      run: (job) => {
        job.append('lands in the record')
        return hooks
      },
    }
    // Negative proof: a plain start's face has no `append` at the type level.
    const plainFace: HasAppend<Parameters<PlainJobStart['run']>[0]> = false
    const recordingFace: HasAppend<Parameters<RecordingJobStart['run']>[0]> = true
    expect(plainFace).toBe(false)
    expect(recordingFace).toBe(true)
    expect(plain.record).toBeUndefined()
    expect(recording.record).toBe(true)
  })
})

describe('JobRegistry seam', () => {
  it('a concrete subclass registers as ctx.jobs and serves the abstract API', async () => {
    const ctx = new Context()
    await ctx.plugin(StubJobRegistry)

    const detachController = ctx.jobs.attachController('seam-test')
    const id = ctx.jobs.start({ kind: 'bash', label: 'sleep 60', run: () => ({ cancel() {}, done: new Promise(() => {}) }) })
    expect(id).toBe('bash-1')
    expect(ctx.jobs.list()).toHaveLength(1)
    expect(ctx.jobs.get(id).status).toBe('running')
    expect(ctx.jobs.read(id).text).toBe('')
    expect(ctx.jobs.kill(id)).toBe('requested')
    await expect(ctx.jobs.wait(id, 5)).resolves.toMatchObject({ id })
    expect(ctx.jobs.readRecord(id, 0)).toEqual({ chunks: [], next: 0, lossy: false })
    const detachListener = ctx.jobs.onJobDone(() => {})
    detachListener()
    const detachChanges = ctx.jobs.onJobsChanged(() => {})
    detachChanges()
    const detachOutput = ctx.jobs.onOutput(() => {})
    detachOutput()
    detachController()
  })

  it('loading a second implementation throws (one jobs service per context — cordis standard)', async () => {
    const ctx = new Context()
    await ctx.plugin(StubJobRegistry)
    class SecondJobRegistry extends StubJobRegistry {}
    await expect(ctx.plugin(SecondJobRegistry)).rejects.toThrow(/service "jobs" has been registered/)
  })

  it('mounting the abstract seam directly fails loudly at load (stale-composition fence)', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(JobRegistry as unknown as typeof StubJobRegistry))
      .rejects.toThrow(/abstract job registry seam; load an implementation such as @deepseek-ai\/dsh-jobs-local/)
  })
})

/** Record every append so pump behavior is observable without a registry. */
function recordingJob(): { job: RecordingJob; appends: { text: string; options?: JobAppendOptions }[] } {
  const appends: { text: string; options?: JobAppendOptions }[] = []
  const job: RecordingJob = {
    id: JobId('bash-1'),
    append(text, options) { appends.push({ text, ...options !== undefined ? { options } : {} }) },
    updateDetail() {},
  }
  return { job, appends }
}

/** A scripted source: each read() shifts the next scripted result. */
function scriptedSource(
  reads: { text: string; lossy?: boolean }[],
  channel?: 'stdout' | 'stderr',
): { source: JobPumpSource; offsets: number[] } {
  const offsets: number[] = []
  let offset = 0
  const source: JobPumpSource = {
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

describe('pumpJobOutput', () => {
  it('rejects a non-positive poll interval before touching any source', async () => {
    const { job } = recordingJob()
    await expect(pumpJobOutput(job, [], { pollMs: 0, done: Promise.resolve() }))
      .rejects.toThrow(/invalid pump pollMs/)
  })

  it('copies labeled deltas at the poll cadence and resumes each source at its own offset', async () => {
    vi.useFakeTimers()
    try {
      const { job, appends } = recordingJob()
      let settle!: () => void
      const done = new Promise<void>((resolve) => { settle = resolve })
      const out = scriptedSource([{ text: 'a' }, { text: 'bc' }], 'stdout')
      const err = scriptedSource([{ text: '' }, { text: 'E' }], 'stderr')
      const pump = pumpJobOutput(job, [out.source, err.source], { pollMs: 50, done })

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

  it('subscribes to done once and holds one poll timer however long the job runs', async () => {
    vi.useFakeTimers()
    try {
      const { job } = recordingJob()
      // A thenable stands in for the producer's done promise, and whatever the
      // pump derives from it counts its own reactions too: a pending promise
      // retains every reaction until it settles, so a day-long job must not
      // gain one per poll round.
      let subscriptions = 0
      let settle!: () => void
      const settled = new Promise<void>((resolve) => { settle = resolve })
      const counting = (promise: Promise<unknown>): Promise<unknown> => ({
        then(onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
          subscriptions += 1
          return counting(promise.then(onFulfilled, onRejected))
        },
      }) as unknown as Promise<unknown>
      const done = counting(settled)
      const { source, offsets } = scriptedSource([])
      const pump = pumpJobOutput(job, [source], { pollMs: 50, done })

      const rounds = 10_000
      await vi.advanceTimersByTimeAsync(50 * rounds)
      expect(offsets).toHaveLength(rounds + 1)
      expect(subscriptions).toBeLessThanOrEqual(2)
      expect(vi.getTimerCount()).toBe(1)

      settle()
      await pump
      expect(offsets).toHaveLength(rounds + 2)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks a lossy source read as a gap so observers see the discontinuity', async () => {
    const { job, appends } = recordingJob()
    const { source } = scriptedSource([{ text: 'tail', lossy: true }])
    await pumpJobOutput(job, [source], { pollMs: 1, done: Promise.resolve() })
    expect(appends).toEqual([{ text: 'tail', options: { gapBefore: true } }])
  })

  it('treats a rejected done as settlement and still drains the final bytes', async () => {
    const { job, appends } = recordingJob()
    const { source } = scriptedSource([{ text: 'last' }])
    await pumpJobOutput(job, [source], { pollMs: 1, done: Promise.reject(new Error('producer broke')) })
    expect(appends).toEqual([{ text: 'last' }])
  })
})
