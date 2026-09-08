/** Preset-scoped model surface for the Host Visualizer authority. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from './index.ts'

/** Stable Cordis plugin name for the preset contribution. */
export const name = 'tool-visualizer-model'

/** Services required from the preset standing scope. */
export const inject = ['systemPrompt', 'tools']

/**
 * Register the Visualizer prompt and tools in this preset's inherited layer.
 * @param ctx - Preset-scoped Cordis context that owns the contribution.
 */
export function apply(ctx: Context): void {
  ctx.inject(['visualizer'], (authorityCtx: Context) => {
    authorityCtx.visualizer.installModelSurface(authorityCtx)
  })
}
