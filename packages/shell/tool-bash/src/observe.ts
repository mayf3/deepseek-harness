/**
 * Record tap for background bash runs: copies the spawned process's captured
 * streams into the job's observation record, so non-consuming observers (the
 * Web client) see live output without touching the job's consuming
 * `readOutput` cursor. Observation is strictly best-effort: absent backend
 * offset readers degrade to no observation, and a pump failure is logged and
 * swallowed — the job path is unaffected either way.
 *
 * @module @deepseek-ai/dsh-tool-bash/observe
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ShellProcess } from '@deepseek-ai/dsh-shell'
import { pumpJobOutput } from '@deepseek-ai/dsh-jobs'
import type { JobPumpSource, RunningJob } from '@deepseek-ai/dsh-jobs'

/**
 * Pump the process's non-consuming offset readers into the job record until
 * the run settles, then drain once more. The returned promise never rejects:
 * a pump failure is logged and the record simply stops advancing, while the
 * process and its job continue untouched.
 * @param ctx - plugin context used for the warning log.
 * @param job - the running job's producer face receiving the copied chunks.
 * @param proc - the started background process handle.
 * @param pollMs - producer-configured pump cadence in milliseconds.
 * @returns resolves after the final drain; fold into the job's `done` chain so
 *   the record holds its final bytes before settlement closes it.
 */
export function observeProcessRecord(
  ctx: Context,
  job: RunningJob,
  proc: ShellProcess,
  pollMs: number,
): Promise<void> {
  const sources: JobPumpSource[] = []
  const stdout = proc.observed?.stdout
  if (stdout !== undefined) sources.push({ channel: 'stdout', read: from => stdout.readFrom(from) })
  const stderr = proc.observed?.stderr
  if (stderr !== undefined) sources.push({ channel: 'stderr', read: from => stderr.readFrom(from) })
  return pumpJobOutput(job, sources, { pollMs, done: proc.done })
    .catch((error: unknown) => {
      ctx.logger.warn(`record observation pump for ${job.id} failed: ${String(error)}`)
    })
}
