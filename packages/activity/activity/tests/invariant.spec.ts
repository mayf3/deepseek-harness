import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import ActivityRegistry, { ActivityId } from '@deepseek-ai/dsh-activity'
import type { ActivitiesChangedListener, ActivitySnapshot } from '@deepseek-ai/dsh-activity'
import * as ProcessInvariant from '@deepseek-ai/dsh-activity/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

const BASE: ActivitySnapshot = {
  id: ActivityId('bash-1'),
  kind: 'bash',
  label: 'compile',
  status: 'completed',
  startedAt: 10,
  finishedAt: 20,
  outputTotal: 12,
  outputEarliest: 4,
}

const RUNNING: ActivitySnapshot = {
  id: ActivityId('bash-1'),
  kind: 'bash',
  label: 'compile',
  status: 'running',
  startedAt: 10,
  outputTotal: 0,
  outputEarliest: 0,
}

/** Boot the companion over a probe registry whose visible set the test controls. */
async function setup(seed: ActivitySnapshot[] = []): Promise<(visible: ActivitySnapshot[], owner?: Agent) => void> {
  const ctx = new Context()
  let current = seed
  let listener: ActivitiesChangedListener | undefined
  const probe = {
    list: () => current,
    onActivitiesChanged(value: ActivitiesChangedListener) {
      listener = value
      return () => { listener = undefined }
    },
  } as unknown as ActivityRegistry
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin({
    name: 'activity-invariant-probe',
    apply(child: Context) { child.provide('activities', probe) },
  })
  await ctx.plugin(ProcessInvariant)
  if (listener === undefined) throw new Error('activity invariant did not subscribe to visible-set changes')
  return (visible, owner) => {
    current = visible
    listener!(owner)
  }
}

describe('process-registry invariants', () => {
  it('accepts coherent running and terminal snapshots', async () => {
    const notify = await setup([RUNNING])
    expect(() => { notify([BASE]) }).not.toThrow()
    expect(() => { notify([{ ...BASE, id: ActivityId('workflow-2'), kind: 'workflow' }]) })
      .not.toThrow()
  })

  it.each([
    [{ ...BASE, id: ActivityId('-1'), kind: '' as ActivitySnapshot['kind'] }, /positive ordinal/],
    [{ ...BASE, id: ActivityId('other-1') }, /must be "bash-" followed by a positive ordinal/],
    [{ ...BASE, id: ActivityId('bash-0') }, /positive ordinal/],
    [{ ...BASE, label: '' }, /label must be non-empty/],
    [{ ...BASE, startedAt: -1 }, /startedAt must be a non-negative epoch integer/],
    [{ ...BASE, status: 'running' as const, finishedAt: 20 }, /finishedAt must be present exactly for a terminal status/],
    [{ ...RUNNING, status: 'killed' as const }, /finishedAt must be present exactly for a terminal status/],
    [{ ...BASE, finishedAt: 9 }, /no earlier than startedAt/],
    [{ ...BASE, outputEarliest: 13 }, /0 <= outputEarliest <= outputTotal/],
    [{ ...BASE, outputTotal: -1, outputEarliest: 0 }, /0 <= outputEarliest <= outputTotal/],
  ] as const)('rejects an incoherent registry snapshot', async (snapshot, message) => {
    const notify = await setup()
    expect(() => { notify([snapshot]) }).toThrow(message)
  })

  it('rejects an incoherent record already present at installation', async () => {
    await expect(setup([{ ...BASE, label: '' }])).rejects.toThrow(/label must be non-empty/)
  })
})
