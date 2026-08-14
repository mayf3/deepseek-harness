/** Package-owned invariant companion for the Team Web presentation. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-agent-team'

/** Cordis companion plugin name. */
export const name = 'client-ui-team-invariant'
/** Invariant registry dependency. */
export const inject = ['invariants']

/** No runtime invariant: RPC is authoritative and the package owns only one disposable slot registration. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant ownership. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
