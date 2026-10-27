/** Awaited, process-local admission boundary for an exact native goal message. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'

/** Definite effect of the driver's synchronous, at-most-once commit closure. */
export type GoalRoundCommitResult = { kind: 'enqueued'; messageId: MessageId } | { kind: 'not_enqueued' }
/** An uncertain transport outcome never authorizes another enqueue. */
export type GoalRoundEnqueueResult = GoalRoundCommitResult | { kind: 'outcome_unknown' }
/** Retained native message and lifecycle-bound commit authority; not a model API. */
export interface GoalRoundEnqueueRequest {
  /** Exact live lifecycle that owns the reservation. */
  agent: Agent
  /** Original native message, retained without source/content reconstruction. */
  message: UserMessage
  /** Abort removes pending owner admission; it never authorizes replay. */
  signal: AbortSignal
  /** Recheck and enqueue synchronously in the owner execution context, at most once. */
  commit: () => GoalRoundCommitResult
}
/** Optional owner supplied before selecting external enqueue mode. */
export interface GoalRoundEnqueue {
  /** Version of the awaited reservation/commit protocol. */
  protocolVersion: 1
  /** Resolve only with the actual enqueue disposition; uncertainty stops continuation. */
  enqueue: (request: GoalRoundEnqueueRequest) => Promise<GoalRoundEnqueueResult>
}

/** Compatibility readback for consumers that require owned external admission. */
export interface GoalRoundDriverCapability {
  /** Version supported by this loaded driver. */
  protocolVersion: 1
  /** Actual configured ownership mode; never inferred from provider presence. */
  enqueueMode: 'native' | 'external'
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** External admission owner; native mode does not call it. */
    goalRoundEnqueue: GoalRoundEnqueue
    /** Capability marker for consumers that require an awaited enqueue boundary. */
    goalRoundDriver: GoalRoundDriverCapability
  }
}

/**
 * Bound an uncooperative provider and remove every listener/timer on settlement.
 * @param ctx - context providing the optional external enqueue owner.
 * @param request - exact native reservation and synchronous commit closure.
 * @param controller - driver-owned cancellation controller for the reservation.
 * @param timeoutMs - positive maximum external wait in milliseconds.
 * @returns actual provider disposition, or uncertainty after an aborted wait.
 */
export async function awaitGoalRoundEnqueue(
  ctx: Context,
  request: GoalRoundEnqueueRequest,
  controller: AbortController,
  timeoutMs: number,
): Promise<GoalRoundEnqueueResult> {
  const provider = ctx.get('goalRoundEnqueue')
  if (provider?.protocolVersion !== 1) return { kind: 'not_enqueued' }
  const aborted = Promise.withResolvers<GoalRoundEnqueueResult>()
  const onAbort = (): void => { aborted.resolve({ kind: 'outcome_unknown' }) }
  request.signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => { controller.abort('timeout') }, timeoutMs)
  try {
    if (request.signal.aborted) return { kind: 'not_enqueued' }
    return await Promise.race([provider.enqueue(request), aborted.promise])
  } finally {
    clearTimeout(timer)
    request.signal.removeEventListener('abort', onAbort)
  }
}
