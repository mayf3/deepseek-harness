#!/usr/bin/env node
/** Inspect the public Claude Code Bundle composition without invoking the product. */

import { boot, loadOverlayPatches, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-tools'

const configPath = process.argv[2]
const bundlePatchPath = process.argv[3]
if (configPath === undefined || bundlePatchPath === undefined) {
  throw new Error('Claude Code Loader composition driver requires config and Bundle patch paths')
}

let starts = 0
const ctx = await boot(
  'subagent-claude-code-loader-composition',
  resolveConfigPath(configPath, undefined),
  loadOverlayPatches('subagent-claude-code-loader-composition', bundlePatchPath),
  (hostCtx) => {
    hostCtx.on('subagent/start', () => {
      starts += 1
    })
  },
)

try {
  const provider = ctx.subagents.getProvider('claude-code')
  if (provider === undefined) throw new Error('claude-code provider was not registered')
  const tool = ctx.tools.schemas().find(schema => schema.name === 'subagent_claude_code')
  if (tool === undefined) throw new Error('subagent_claude_code tool was not registered')
  const properties = tool.parameters.properties
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    throw new Error('subagent_claude_code has invalid parameter properties')
  }

  process.stdout.write(`${JSON.stringify({
    providers: ctx.subagents.list(),
    provider: {
      name: provider.name,
      capabilities: provider.capabilities,
      inheritsParentContext: provider.inheritsParentContext,
    },
    tool: {
      name: tool.name,
      parameterNames: Object.keys(properties).sort(),
      required: tool.parameters.required,
    },
    jobTools: ctx.tools.schemas()
      .map(schema => schema.name)
      .filter(name => name === 'job_kill' || name === 'job_list' || name === 'job_output')
      .sort(),
    starts,
  })}\n`)
} finally {
  await ctx.fiber.dispose()
}
