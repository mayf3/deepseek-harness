/**
 * Best-effort process-observation tap for background bash runs: mirrors the
 * spawned process's captured streams into `ctx.activities` so non-consuming
 * observers (the Web client) see live output without touching the job's
 * consuming `readOutput` cursor. Absent registry or absent backend offset
 * readers degrade to no observation; the job path is unaffected either way.
 *
 * @module @deepseek-ai/dsh-tool-bash/observe
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ShellProcess } from '@deepseek-ai/dsh-shell'
import { pumpActivityOutput } from '@deepseek-ai/dsh-activity'
import type { ActivityCorrelation, ActivityKind, ActivityPumpSource } from '@deepseek-ai/dsh-activity'

/** Identity of one observed background run. */
export interface ObserveBackgroundSpec {
  /** Process kind — the producing tool's registered {@link ActivityKind}. */
  kind: ActivityKind
  /** One-line label (the command). */
  label: string
  /** Owning live agent, when the call has one. */
  owner?: Agent
  /** Links to the starting tool call and the registered job. */
  correlation: ActivityCorrelation
}

/**
 * Open a process beside a committed background job and pump the handle's
 * non-consuming offset readers into it until the run settles, then record the
 * mapped outcome. Observation is strictly best-effort: without a
 * `ctx.activities` registry this is a no-op, without backend offset readers
 * the process still carries status and settlement, and ANY observation
 * failure — including a rejected `open()` — is logged and swallowed, because
 * the background job is already committed and running.
 * @param ctx - plugin context used for the optional registry and warning logs.
 * @param proc - the started background process handle.
 * @param spec - process identity and correlation for the registry row.
 * @param pollMs - producer-configured pump cadence in milliseconds.
 * @param outcome - maps the settled handle to the process outcome.
 */
export function observeBackgroundActivity(
  ctx: Context,
  proc: ShellProcess,
  spec: ObserveBackgroundSpec,
  pollMs: number,
  outcome: (proc: ShellProcess) => { status: 'completed' | 'killed'; detail: string },
): void {
  try {
    const processes = ctx.get('activities')
    if (processes === undefined) return
    const handle = processes.open({
      kind: spec.kind,
      label: spec.label,
      ...spec.owner !== undefined ? { owner: spec.owner } : {},
      correlation: spec.correlation,
    })
    const sources: ActivityPumpSource[] = []
    const stdout = proc.observed?.stdout
    if (stdout !== undefined) sources.push({ channel: 'stdout', read: from => stdout.readFrom(from) })
    const stderr = proc.observed?.stderr
    if (stderr !== undefined) sources.push({ channel: 'stderr', read: from => stderr.readFrom(from) })
    void pumpActivityOutput(handle, sources, { pollMs, done: proc.done })
      .catch((error: unknown) => {
        ctx.logger.warn(`activity observation pump for ${handle.id} failed: ${String(error)}`)
      })
      .then(() => { handle.end(outcome(proc)) })
  } catch (error: unknown) {
    ctx.logger.warn(`activity observation unavailable for this run: ${String(error)}`)
  }
}
