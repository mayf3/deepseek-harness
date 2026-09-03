/**
 * Live-progress mirror for background workflow runs: streams the engine's
 * `workflow/phase`, `workflow/log`, and member lifecycle events into the
 * owning job's output ring as text lines, and keeps the job's live progress
 * line on the current phase. Appends against a settled job log and drop
 * inside the registry, so a straggling event after settlement is harmless.
 * @module @deepseek-ai/dsh-tool-workflow/record
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JobHandle } from '@deepseek-ai/dsh-jobs'
import type { WorkflowRunId } from '@deepseek-ai/dsh-workflow'

/** Job-ring taps for the background runs the tool tracks. */
export interface WorkflowRecordMirror {
  /**
   * Route a run's progress events into a job's ring. Call once per background
   * run, from the job starter, before the worker publishes its first event.
   * @param runId - the started run.
   * @param job - the owning job's producer face.
   */
  start(runId: WorkflowRunId, job: JobHandle): void
  /**
   * Stop routing a settled or abandoned run. Idempotent.
   * @param runId - the run to drop.
   */
  stop(runId: WorkflowRunId): void
}

/**
 * Create the run-to-ring mirror and subscribe the engine's live progress
 * events for the runs it tracks.
 * @param ctx - plugin context whose event bus carries the `workflow/*` events.
 * @returns the mirror taps the tool wires around each background run.
 */
export function createWorkflowRecordMirror(ctx: Context): WorkflowRecordMirror {
  const active = new Map<WorkflowRunId, JobHandle>()

  ctx.on('workflow/phase', (info, title) => {
    const job = active.get(info.id)
    if (job === undefined) return
    job.updateProgress(title)
    job.append(`▸ ${title}\n`)
  })
  ctx.on('workflow/log', (info, message) => {
    active.get(info.id)?.append(`${message}\n`)
  })
  ctx.on('workflow/agent-start', (info, agent) => {
    active.get(info.id)?.append(`agent #${agent.seq} ${agent.label} started\n`)
  })
  ctx.on('workflow/agent-end', (info, agent) => {
    active.get(info.id)?.append(`agent #${agent.seq} ${agent.outcome}\n`)
  })

  return {
    start(runId, job) {
      active.set(runId, job)
    },
    stop(runId) {
      active.delete(runId)
    },
  }
}
