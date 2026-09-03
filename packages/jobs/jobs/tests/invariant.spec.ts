import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import JobRegistry, { JobId } from '@deepseek-ai/dsh-jobs'
import type { JobEventListener, JobView } from '@deepseek-ai/dsh-jobs'
import * as JobsInvariant from '@deepseek-ai/dsh-jobs/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

const BASE: JobView = {
  id: JobId('bash-1'),
  kind: 'bash',
  label: 'compile',
  status: 'completed',
  startedAt: 10,
  finishedAt: 20,
  output: { total: 0, earliest: 0 },
}

const RUNNING: JobView = {
  id: JobId('bash-1'),
  kind: 'bash',
  label: 'compile',
  status: 'running',
  startedAt: 10,
  output: { total: 0, earliest: 0 },
}

const TERMINAL_WITHOUT_FINISH: JobView = {
  id: JobId('bash-1'),
  kind: 'bash',
  label: 'compile',
  status: 'completed',
  startedAt: 10,
  output: { total: 0, earliest: 0 },
}

async function setup(seed: JobView[] = []): Promise<(job: unknown) => void> {
  const ctx = new Context()
  let listener: JobEventListener | undefined
  const probe = {
    visibleTo: () => ({ list: () => seed }),
    events: {
      subscribe(_filter: unknown, value: JobEventListener) {
        listener = value
        return () => { listener = undefined }
      },
    },
  } as unknown as JobRegistry
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin({
    name: 'job-invariant-probe',
    apply(child: Context) { child.provide('jobs', probe) },
  })
  await ctx.plugin(JobsInvariant)
  if (listener === undefined) throw new Error('job invariant did not subscribe to settlements')
  return (job) => { listener!({ type: 'settled', job: job as JobView, cause: 'producer' }) }
}

describe('job-registry invariants', () => {
  it('accepts coherent current and terminal projections', async () => {
    const notify = await setup([RUNNING])
    expect(() => { notify(BASE) }).not.toThrow()
    expect(() => { notify({ ...BASE, id: JobId('subagent-2'), kind: 'subagent', owner: SessionId('owner') }) })
      .not.toThrow()
    expect(() => { notify({ ...BASE, output: { total: 8, earliest: 4 } }) }).not.toThrow()
  })

  it('ignores non-settlement events', async () => {
    const ctx = new Context()
    let listener: JobEventListener | undefined
    const probe = {
      visibleTo: () => ({ list: () => [] }),
      events: { subscribe(_filter: unknown, value: JobEventListener) { listener = value; return () => {} } },
    } as unknown as JobRegistry
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin({ name: 'job-invariant-probe', apply(child: Context) { child.provide('jobs', probe) } })
    await ctx.plugin(JobsInvariant)
    expect(() => { listener!({ type: 'registered', job: { ...BASE, label: '' } }) }).not.toThrow()
  })

  it.each([
    [{ ...BASE, id: JobId('-1'), kind: '' }, /positive ordinal/],
    [{ ...BASE, id: JobId('other-1') }, /must be "bash-" followed by a positive ordinal/],
    [{ ...BASE, id: JobId('bash-x') }, /positive ordinal/],
    [{ ...BASE, id: JobId('bash-0') }, /positive ordinal/],
    [{ ...BASE, startedAt: -1 }, /startedAt must be a non-negative epoch integer/],
    [{ ...BASE, startedAt: 0.5 }, /startedAt must be a non-negative epoch integer/],
    [{ ...BASE, status: 'running' }, /finishedAt must be present exactly for a terminal status/],
    [TERMINAL_WITHOUT_FINISH, /finishedAt must be present exactly for a terminal status/],
    [{ ...BASE, finishedAt: 9 }, /no earlier than startedAt/],
    [{ ...BASE, finishedAt: 20.5 }, /no earlier than startedAt/],
    [{ ...BASE, progress: '3/10' }, /progress must be cleared once settled/],
    [{ ...BASE, output: { total: 8, earliest: 9 } }, /0 <= earliest <= total/],
    [{ ...BASE, output: { total: 8.5, earliest: 0 } }, /0 <= earliest <= total/],
    [{ ...BASE, output: { total: 8, earliest: 0.5 } }, /0 <= earliest <= total/],
    [{ ...BASE, output: { total: 8, earliest: -1 } }, /0 <= earliest <= total/],
  ] as const)('rejects an incoherent registry projection', async (job, message) => {
    const notify = await setup()
    expect(() => { notify(job) }).toThrow(message)
  })

  it('rejects an incoherent projection already present at installation', async () => {
    await expect(setup([{ ...BASE, label: '' }])).rejects.toThrow(/label must be non-empty/)
  })
})
