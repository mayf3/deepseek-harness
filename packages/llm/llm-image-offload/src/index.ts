/**
 * Durable request-image offload on the agent loop's step extension points.
 * Before a step enters, the plugin plans the session's `image/offload`
 * watermark from the request-image budget of the route the latest
 * `request/header` names; when an adapter fails an attempt with
 * `IMAGE_OFFLOAD_REQUIRED`, it advances the watermark by the named count and
 * retries the step, so every dispatched request carries the offloaded set the
 * log records.
 *
 * @module @deepseek-ai/dsh-llm-image-offload
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreStepDecision, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import { IMAGE_OFFLOAD_REQUIRED_CODE, LlmError, offloadedImagePrefixCount, representedImageBytes, visitImageBlocks } from '@deepseek-ai/dsh-llm'
import type { LlmImageRequestBudget } from '@deepseek-ai/dsh-llm'
import { compareImagePositions } from '@deepseek-ai/dsh-session'
import type { ImageOccurrencePosition, Session } from '@deepseek-ai/dsh-session'

export const name = 'llm-image-offload'
export const inject = ['llm', 'agents']

/** The plugin has no configuration; image-capable routes declare their budgets. */
export type Config = Readonly<Record<string, never>>

/** Runtime schema for {@link Config}. */
export const Config = z.object({}) as unknown as z<Config>

/** One image occurrence the surface still sends. */
interface RetainedOccurrence {
  /** Durable position an advance names when this occurrence becomes the last offloaded one. */
  readonly position: ImageOccurrencePosition
  /** Normalized attachment byte count. */
  readonly bytes: number
}

/** Every retained image occurrence in model request order. */
function retainedOccurrences(session: Session): RetainedOccurrence[] {
  const watermark = session.imageOffloadWatermark()
  const retained: RetainedOccurrence[] = []
  for (const seq of session.surface.nodes) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- surface nodes index the durable log
    const message = session.deriveEventMessage(session.eventAt(seq)!)
    if (message === null) continue
    visitImageBlocks(message.content, (block, path) => {
      const position = { seq, path: [...path] }
      if (watermark !== undefined && compareImagePositions(position, watermark) <= 0) return
      retained.push({ position, bytes: block.attachment.bytes })
    })
  }
  return retained
}

/**
 * Advance the watermark past the `count` oldest retained occurrences. A
 * surface replacement can place a newer event before older ones in request
 * order, so the advance names the greatest durable position in that prefix,
 * which may offload additional occurrences but always covers the prefix.
 * @returns whether any occurrence remained to offload.
 */
function advance(session: Session, turn: number, step: number, count: number): boolean {
  let watermark: ImageOccurrencePosition | undefined
  for (const occurrence of retainedOccurrences(session).slice(0, count)) {
    if (watermark === undefined || compareImagePositions(occurrence.position, watermark) > 0) {
      watermark = occurrence.position
    }
  }
  if (watermark === undefined) return false
  session.append('image/offload', { turn, step, watermark })
  return true
}

/** Request-image budget of the route the latest request header names; undefined before the first header or for a route without one. */
async function routedBudget(ctx: Context, session: Session, signal: AbortSignal): Promise<LlmImageRequestBudget | undefined> {
  const config = session.requestHeader()?.config
  if (config === undefined) return undefined
  try {
    return (await ctx.llm.resolveModelInfo(config.provider, config.model, signal)).imageRequest
  } catch (error: unknown) {
    // Middleware may serve a route without an adapter; the loop dispatches it the same way.
    if (error instanceof LlmError && error.code === 'NO_ADAPTER') return undefined
    throw error
  }
}

/**
 * Mount the offload listeners.
 * @param ctx - the plugin context.
 * @param _config - no configuration.
 */
export function apply(ctx: Context, _config: Config = {}): void {
  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const budget = await routedBudget(ctx, agent.session, signal)
    if (budget === undefined || signal.aborted) return decision
    const retained = retainedOccurrences(agent.session)
    const count = offloadedImagePrefixCount(
      retained.map(occurrence => representedImageBytes(occurrence.bytes, budget)),
      budget,
    )
    if (count > 0) advance(agent.session, turn, step, count)
    return decision
  })

  ctx.on('agent/request-error', ({ agent, turn, step, failure }, next): Promise<RequestErrorAction> => {
    if (failure.code !== IMAGE_OFFLOAD_REQUIRED_CODE || failure.offloadImages === undefined) return next()
    if (!advance(agent.session, turn, step, failure.offloadImages)) return next()
    return Promise.resolve<RequestErrorAction>({ kind: 'retry' })
  })
}
