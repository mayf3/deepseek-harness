/** Client assembly for the generated Agent Teams Remote contribution. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import teamsRemote from '@deepseek-ai/dsh-team/remote'

export type {} from '@deepseek-ai/dsh-team/remote'

/** Required service: the typed Client Remote contribution mount. */
export const inject = ['remote']

/**
 * Mount the Agent Teams Remote namespace selected by the experimental Web profile.
 * @param ctx - Client Cordis root carrying the Remote service.
 * @returns disposer after the contribution is ready.
 */
export function apply(ctx: Context): Promise<() => Promise<void>> {
  return ctx.remote.$mount(teamsRemote)
}
