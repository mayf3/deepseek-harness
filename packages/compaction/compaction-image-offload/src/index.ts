/**
 * Image offload executor for the compaction seam. When an image-capable route
 * fails a request with `IMAGE_OFFLOAD_REQUIRED`, the plugin replaces the
 * surface nodes carrying the named count of oldest retained image occurrences
 * with copies marked `offloaded`, prices each replaced node through the
 * shared `compaction/prune` protocol, and retries the step on the
 * `agent/request-error` waterfall. Every route then sends placeholder text
 * for those occurrences, and the replacement never reverts.
 *
 * @module @deepseek-ai/dsh-compaction-image-offload
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { RequestErrorAction } from '@deepseek-ai/dsh-agent'
import { IMAGE_OFFLOAD_REQUIRED_CODE } from '@deepseek-ai/dsh-llm'
import { offloadOldestImages } from './image-offload.ts'

export const name = 'compaction-image-offload'
export const inject = ['agents', 'tokenMeter']

/** The executor has no configuration; image-capable routes own their budgets. */
export type Config = Readonly<Record<string, never>>

/** Runtime schema for {@link Config}. */
export const Config = z.object({}) as unknown as z<Config>

/**
 * Mount the recovery listener.
 * @param ctx - the plugin context.
 * @param _config - no configuration.
 */
export function apply(ctx: Context, _config: Config = {}): void {
  ctx.on('agent/request-error', ({ agent, failure }, next): Promise<RequestErrorAction> => {
    if (failure.code !== IMAGE_OFFLOAD_REQUIRED_CODE || failure.offloadImages === undefined) return next()
    // A durable surface repair, not a provider retry: it spends no retry budget and logs no retry event.
    if (!offloadOldestImages(ctx, agent.session, failure.offloadImages)) return next()
    return Promise.resolve<RequestErrorAction>({ kind: 'retry' })
  })
}
