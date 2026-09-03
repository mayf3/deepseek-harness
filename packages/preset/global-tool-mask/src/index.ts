/**
 * A global-tool mask as a composable row.
 *
 * `dsh-tools` lets an agent scope restrict the host's global tools through
 * `tools.restrict()`, and nothing in a composition file could call it: a
 * preset can add rows, but the tools a host row registers reach every
 * session through the global layer. This row is that call as a row —
 * **scope-only**, like `dsh-persona`: mounted inside an agent preset it hides
 * the named global tools from the sessions the preset composes; mounted
 * globally it rejects, because a context-global restriction would mask every
 * agent. A preset's user patch layer is where the row is meant to land, so a
 * person can hide a host tool from one preset without editing the file the
 * deployment ships.
 * @module @deepseek-ai/dsh-global-tool-mask
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'

/** Cordis plugin name. */
export const name = 'global-tool-mask'

/** The registry this row masks. */
export const inject = ['tools']

/** Plugin config: the global-tool mask, in `tools.restrict()`'s own vocabulary. */
export interface Config {
  /** Global tool names that stay visible; everything else is hidden. Empty means no allow list. */
  allow: string[]
  /** Global tool names hidden from this scope. Empty means no deny list. */
  deny: string[]
}

/** Runtime schema for the mask row. */
export const Config: z<Config> = z.object({
  allow: z.array(z.string()),
  deny: z.array(z.string()),
})

/**
 * Restrict the global tools visible to the mounting context's scope.
 * @param ctx - an agent scope context; an unscoped context rejects, as does
 * a mask that names no tool or names one the host does not register.
 * @param config - the mask; `allow` and `deny` intersect when both are given.
 * An empty list is the same as an absent one: the schema materializes a
 * missing list as `[]`, and an empty `allow` would otherwise hide every tool.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.tools.restrict({
    ...config.allow.length === 0 ? {} : { allow: config.allow },
    ...config.deny.length === 0 ? {} : { deny: config.deny },
  }), 'global-tool-mask.restrict()')
}
