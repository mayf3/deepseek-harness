/** Agent Teams runtime invariant companion. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-agent-team'

/** Cordis companion plugin name. */
export const name = 'team-invariant'
/** Invariant registry required by the companion. */
export const inject = ['invariants']

/** No runtime invariant: the Team projection owns event decoding and relational state transitions. */
const install: InvariantInstaller = () => {}

/** Register the package invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
