import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalActivityRegistry from '@deepseek-ai/dsh-activity-local'
import type { WorkflowRun, WorkflowRunId, WorkflowRunInfo } from '@deepseek-ai/dsh-workflow'
import { createWorkflowActivityMirror } from '../src/activity.ts'

function runStub(id = 'run-1'): { run: WorkflowRun; info: WorkflowRunInfo } {
  const info = { id: id as WorkflowRunId, meta: { name: 'docs-sweep' } } as WorkflowRunInfo
  return {
    run: { id: id as WorkflowRunId, meta: { name: 'docs-sweep' } } as WorkflowRun,
    info,
  }
}

function retainedText(ctx: Context): string {
  const row = ctx.activities.list()[0]
  if (row === undefined) throw new Error('no mirrored activity')
  return ctx.activities.read(row.id, 0).chunks.map(chunk => chunk.text).join('')
}

describe('workflow activity mirror', () => {
  it('opens one workflow activity per run and streams phase, log, and member lines', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalActivityRegistry)
    const mirror = createWorkflowActivityMirror(ctx)
    const { run, info } = runStub()
    mirror.start(run, undefined)

    const row = ctx.activities.list()[0]
    expect(row?.kind).toBe('workflow')
    expect(row?.label).toBe('docs-sweep')

    ctx.emit('workflow/phase', info, 'Scan')
    ctx.emit('workflow/log', info, '3 files queued')
    ctx.emit('workflow/agent-start', info, { seq: 1, label: 'reader', childId: 'c1' } as never)
    ctx.emit('workflow/agent-end', info, { seq: 1, label: 'reader', childId: 'c1', outcome: 'completed' } as never)
    expect(ctx.activities.get(row!.id).detail).toBe('Scan')
    expect(retainedText(ctx)).toBe('▸ Scan\n3 files queued\nagent #1 reader started\nagent #1 completed\n')

    mirror.finish(run.id, 'completed')
    const settled = ctx.activities.get(row!.id)
    expect(settled.status).toBe('completed')
    // The always-run abandon after a normal finish is inert.
    mirror.abandon(run.id)
    expect(ctx.activities.get(row!.id).status).toBe('completed')
  })

  it('maps cancelled and error stops, and ends an abandoned run as killed', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalActivityRegistry)
    const mirror = createWorkflowActivityMirror(ctx)

    const cancelled = runStub('run-c')
    mirror.start(cancelled.run, undefined)
    mirror.finish(cancelled.run.id, 'cancelled')

    const failed = runStub('run-e')
    mirror.start(failed.run, undefined)
    mirror.finish(failed.run.id, 'error')

    const orphaned = runStub('run-o')
    mirror.start(orphaned.run, undefined)
    mirror.abandon(orphaned.run.id)

    const byLabelOrder = ctx.activities.list()
    expect(byLabelOrder.map(row => [row.status, row.detail])).toEqual([
      ['killed', 'cancelled'],
      ['failed', 'error'],
      ['killed', 'run abandoned'],
    ])
  })

  it('ignores events for untracked runs and stays inert without the registry', async () => {
    const bare = new Context()
    const inert = createWorkflowActivityMirror(bare)
    const { run, info } = runStub()
    // No registry: every tap is a no-op rather than a throw.
    inert.start(run, undefined)
    bare.emit('workflow/log', info, 'dropped')
    inert.finish(run.id, 'completed')
    inert.abandon(run.id)

    const ctx = new Context()
    await ctx.plugin(LocalActivityRegistry)
    createWorkflowActivityMirror(ctx)
    // Events for a run the mirror never opened change nothing.
    ctx.emit('workflow/phase', info, 'ghost')
    expect(ctx.activities.list()).toEqual([])
  })

  it('contains a throwing registry so the run path never breaks', async () => {
    const ctx = new Context()
    const warn = vi.fn()
    ctx.logger.warn = warn as never
    await ctx.plugin({
      name: 'broken-activities-probe',
      apply(child: Context) {
        child.provide('activities', { open() { throw new Error('mirror boom') } })
      },
    })
    const mirror = createWorkflowActivityMirror(ctx)
    const { run } = runStub()
    expect(() => { mirror.start(run, undefined) }).not.toThrow()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('workflow activity mirror open failed'))
  })
})
