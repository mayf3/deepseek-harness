/**
 * Best-effort activity mirror for top-level workflow runs: opens one
 * `workflow` activity per run and streams the engine's `workflow/phase`,
 * `workflow/log`, and member lifecycle events into it as text lines, so the
 * Web client shows live progress the session log deliberately does not carry
 * per line. Without a `ctx.activities` registry every operation is a no-op,
 * and ANY mirror failure is logged and swallowed — the run is unaffected.
 *
 * @module @deepseek-ai/dsh-tool-workflow/activity
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ActivityHandle } from '@deepseek-ai/dsh-activity'
import type { WorkflowRun, WorkflowRunId, WorkflowStopReason } from '@deepseek-ai/dsh-workflow'

declare module '@deepseek-ai/dsh-activity' {
  interface ActivityKindMap {
    workflow: 'workflow'
  }
}

/** Activity taps for the three points the tool already tracks a run at. */
export interface WorkflowActivityMirror {
  /**
   * Open the run's activity. Call once per recorded top-level run.
   * @param run - the started run (id and meta name).
   * @param owner - the calling agent, when the call has one.
   */
  start(run: WorkflowRun, owner: Agent | undefined): void
  /**
   * End the run's activity with the mapped stop reason.
   * @param runId - the settled run.
   * @param stopReason - how the run stopped.
   */
  finish(runId: WorkflowRunId, stopReason: WorkflowStopReason): void
  /**
   * Drop tracking for a run that ends without a settled reason. First-wins
   * with {@link finish}: after a normal finish this is inert.
   * @param runId - the abandoned run.
   */
  abandon(runId: WorkflowRunId): void
}

/** Map a run's stop reason onto the activity outcome vocabulary. */
function outcomeOf(stopReason: WorkflowStopReason): { status: 'completed' | 'failed' | 'killed'; detail: string } {
  switch (stopReason) {
    case 'completed': return { status: 'completed', detail: 'completed' }
    case 'cancelled': return { status: 'killed', detail: 'cancelled' }
    case 'error': return { status: 'failed', detail: 'error' }
  }
}

/**
 * Create the run-to-activity mirror and subscribe the engine's live progress
 * events for the runs it tracks.
 * @param ctx - plugin context used for the optional registry and warning logs.
 * @returns the mirror taps the tool wires beside its durable recorder.
 */
export function createWorkflowActivityMirror(ctx: Context): WorkflowActivityMirror {
  const active = new Map<WorkflowRunId, ActivityHandle>()
  const contained = (operation: string, act: () => void): void => {
    try {
      act()
    } catch (error: unknown) {
      ctx.logger.warn(`workflow activity mirror ${operation} failed: ${String(error)}`)
    }
  }

  ctx.on('workflow/phase', (info, title) => {
    const handle = active.get(info.id)
    if (handle === undefined) return
    contained('phase', () => {
      handle.updateDetail(title)
      handle.append(`▸ ${title}\n`)
    })
  })
  ctx.on('workflow/log', (info, message) => {
    const handle = active.get(info.id)
    if (handle === undefined) return
    contained('log', () => { handle.append(`${message}\n`) })
  })
  ctx.on('workflow/agent-start', (info, agent) => {
    const handle = active.get(info.id)
    if (handle === undefined) return
    contained('agent-start', () => { handle.append(`agent #${agent.seq} ${agent.label} started\n`) })
  })
  ctx.on('workflow/agent-end', (info, agent) => {
    const handle = active.get(info.id)
    if (handle === undefined) return
    contained('agent-end', () => { handle.append(`agent #${agent.seq} ${agent.outcome}\n`) })
  })

  return {
    start(run, owner) {
      contained('open', () => {
        const activities = ctx.get('activities')
        if (activities === undefined) return
        active.set(run.id, activities.open({
          kind: 'workflow',
          label: run.meta.name,
          ...owner !== undefined ? { owner } : {},
        }))
      })
    },
    finish(runId, stopReason) {
      const handle = active.get(runId)
      active.delete(runId)
      if (handle === undefined) return
      contained('finish', () => { handle.end(outcomeOf(stopReason)) })
    },
    abandon(runId) {
      const handle = active.get(runId)
      active.delete(runId)
      if (handle === undefined) return
      contained('abandon', () => { handle.end({ status: 'killed', detail: 'run abandoned' }) })
    },
  }
}
