/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-activity-local`.
 * @module @deepseek-ai/dsh-activity-local/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-activity-local'

/** Cordis companion plugin name. */
export const name = 'activity-local-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: `@deepseek-ai/dsh-activity/invariant` owns per-snapshot identity, status,
 * timestamp, and offset checks on every visible-set change. This provider's remaining behavior —
 * ring retention against private byte caps and pull-only chunk reads — has no authoritative event
 * stream to observe: a read happens on a caller's schedule, and repeating the retention arithmetic
 * against private configuration would duplicate the implementation rather than check a relation.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
