/** Package-owned invariant companion for the Agent Teams Remote adapter. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-agent-team-remotes'

/** Cordis companion plugin name. */
export const name = 'agent-team-remotes-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

// No runtime invariant: generated codecs validate the adapter's requests and
// results, while the Team service owns every mutable relationship.
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
