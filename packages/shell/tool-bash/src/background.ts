/**
 * Generic-job adaptation for background bash process handles: the terminal
 * outcome the registry records and the pull sources it pumps.
 *
 * @module @deepseek-ai/dsh-tool-bash/background
 */

import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { escalationHintMarker, sandboxDenialMarker } from '@deepseek-ai/dsh-sandbox'
import type { ShellProcess, ShellSandboxInfo } from '@deepseek-ai/dsh-shell'
import type { JobOutcome, JobOutputSource } from '@deepseek-ai/dsh-jobs'

/**
 * Sandbox facts worth the terminal detail: a runner that never ran the
 * command, or a denial (with the escalation hint this composition offers).
 * @param sandbox - settled sandbox facts, when this was a confined process.
 * @param escalationModes - escalation targets advertised by this composition.
 * @returns the markers to append, oldest first.
 */
function sandboxNotes(sandbox: ShellSandboxInfo | undefined, escalationModes: readonly SandboxMode[]): string[] {
  if (sandbox?.runnerFailed) {
    return [`[sandbox: the sandbox runner itself failed under ${sandbox.mode} mode — the command did not run; this is a sandbox problem, not a command failure]`]
  }
  if (sandbox?.denied) {
    const notes = [sandboxDenialMarker(sandbox.mode)]
    if (escalationModes.length > 0) notes.push(escalationHintMarker('command'))
    return notes
  }
  return []
}

/**
 * Map a settled background process onto the generic job-outcome vocabulary:
 * `killed` stays `killed` (detail: the signal when one is known), everything
 * else is `completed` with the exit code as detail. A nonzero command exit is
 * reported, not failed, exactly like the foreground rendering. Sandbox facts
 * join the detail, since a job's terminal reason is the one line every
 * reader — the model's status line, the roster row — shows.
 * @param proc - the settled process handle.
 * @param escalationModes - escalation targets advertised by this composition.
 * @returns the outcome for the `ctx.jobs` registration.
 */
export function processOutcome(proc: ShellProcess, escalationModes: readonly SandboxMode[] = []): JobOutcome {
  // TODO(background-infrastructure-outcome): widen ShellProcess with an explicit
  // infrastructure-failure outcome, then map it to job `failed`. Restricted
  // runner failures expose sandbox.runnerFailed, but unconfined spawn failures
  // still alias a signal-less kill; real nonzero command exits must remain
  // `completed`.
  const base: JobOutcome = proc.status === 'killed'
    ? { status: 'killed', detail: proc.signal !== null ? `signal: ${proc.signal}` : 'killed before exit' }
    : { status: 'completed', detail: `exit code: ${proc.exitCode ?? 0}` }
  const notes = sandboxNotes(proc.sandbox, escalationModes)
  return notes.length === 0 ? base : { ...base, detail: `${base.detail}; ${notes.join(' ')}` }
}

/**
 * The process's non-consuming stream readers as registry pull sources. They
 * bind lazily because the process is spawned inside the starter, after the
 * registry admitted the job; a backend without offset readers degrades to no
 * observation rather than an error, and the pump keeps the model's consuming
 * cursor untouched.
 * @param proc - the started process, once the starter has spawned it.
 * @returns one source per stream, stdout first.
 */
export function processSources(proc: () => ShellProcess | undefined): JobOutputSource[] {
  const source = (channel: 'stdout' | 'stderr'): JobOutputSource => ({
    channel,
    read: (fromByte) => {
      const reader = proc()?.observed?.[channel]
      return reader === undefined ? { text: '', nextOffset: fromByte, lossy: false } : reader.readFrom(fromByte)
    },
  })
  return [source('stdout'), source('stderr')]
}
