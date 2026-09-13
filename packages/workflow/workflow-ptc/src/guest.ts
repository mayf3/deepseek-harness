/** Executes one workflow VM inside the mounted PTC runtime's Node process. */

import type { WorkflowResult } from '@deepseek-ai/dsh-workflow'
import type { WorkflowGuestHost, WorkflowProgress } from './guest-types.ts'
import { renderThrown } from './realm.ts'
import { WorkflowExecution } from './runtime.ts'
import type { ExecutionObserver } from './runtime.ts'
import type { ChildPort } from './types.ts'

/**
 * Run a workflow and await every progress callback before returning its result.
 * Cancellation belongs to the PTC runtime and the host's child cleanup.
 * @param host - JSON callbacks owned by this workflow run.
 * @returns The script result after progress delivery; initialization failures reject.
 */
export async function runWorkflowGuest(host: WorkflowGuestHost): Promise<WorkflowResult> {
  const init = await host.begin({})
  const progress = new Set<Promise<void>>()
  let progressError: string | undefined
  const send = (event: WorkflowProgress): void => {
    // Start the callback synchronously so narration reaches the host before a hot loop.
    const task = host.progress(event).then(
      () => {},
      (error: unknown) => { progressError ??= renderThrown(error) },
    )
    progress.add(task)
    void task.then(() => { progress.delete(task) })
  }
  const observer: ExecutionObserver = {
    phase: (title) => { send({ type: 'phase', title }) },
    log: (message) => { send({ type: 'log', message }) },
    agentStart: (info) => { send({ type: 'agent-start', info }) },
    agentEnd: (info) => { send({ type: 'agent-end', info }) },
  }
  const children: ChildPort = {
    async startAgent(request) {
      const { callId, childId } = await host.startChild(request)
      const result = host.childResult({ callId })
      // A dropped agent() call must not turn a child failure into an unhandled rejection.
      void result.catch(() => {})
      return {
        id: childId,
        result,
        async dispose() { await host.disposeChild({ callId }) },
      }
    },
  }
  const execution = new WorkflowExecution(init.meta, init.body, init.args, init.limits, observer, children)
  const result = await execution.drive()
  await Promise.all(progress)
  return progressError === undefined ? result : {
    value: null,
    stopReason: 'error',
    error: progressError,
    agentsStarted: result.agentsStarted,
  }
}
