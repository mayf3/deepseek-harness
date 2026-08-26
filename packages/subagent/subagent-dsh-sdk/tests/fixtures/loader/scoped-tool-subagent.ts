/** Mount the SDK delegation tool in each fixture Agent's scope. */

import type { Context } from '@deepseek-ai/cordis'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import type { Config } from '@deepseek-ai/dsh-tool-subagent'

export const name = 'scoped-tool-subagent'
export const inject = ['agents', 'subagentModelSelection']

/**
 * Install the configured delegation tool before a published Agent starts its loop.
 * @param ctx - fixture Host context carrying Agent lifecycle events.
 * @param config - delegation-tool configuration forwarded into each Agent scope.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.plugin(ToolSubagent, { ...config, modelSelectionSettings: true })
  })
}
