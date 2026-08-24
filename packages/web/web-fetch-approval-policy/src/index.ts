/**
 * Per-call permission policy for the `web_fetch` tool. Restricted sandbox
 * modes require one-shot user approval after a public-address preflight;
 * danger-full-access delegates without asking. The HTTP provider independently
 * repeats resolution and pins the validated addresses for the actual request.
 *
 * @module @deepseek-ai/dsh-web-fetch-approval-policy
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-user-approval'
import { preflightPublicFetchUrl } from '@deepseek-ai/dsh-web-fetch-http'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-fetch-approval-policy'

/** Services used to decide each `web_fetch` execution. */
export const inject = ['tools', 'sandboxPolicy', 'approval']

/** Return the URL argument that can reach `web_fetch`, or undefined for a call its own schema will reject. */
function fetchUrlOf(exec: ToolExecution): string | undefined {
  const args = exec.arguments
  if (typeof args !== 'object' || args === null || !('url' in args)) return undefined
  return typeof args.url === 'string' ? args.url : undefined
}

/** Register sandbox- and approval-aware one-shot permission policy for `web_fetch`. */
export function apply(ctx: Context): void {
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (exec.name !== 'web_fetch') return next()

    const agent = exec.agent
    if (agent === undefined) {
      return { kind: 'deny', reason: 'web_fetch requires an agent-scoped permission decision' }
    }

    const mode = ctx.sandboxPolicy.resolve({ session: agent.session }).mode
    if (mode === 'danger-full-access') return next()

    if (ctx.approval.effectivePolicy(agent.session) === 'never') {
      return {
        kind: 'deny',
        reason: `web_fetch is not pre-approved in ${mode} mode and approval prompts are disabled`,
      }
    }

    const rawUrl = fetchUrlOf(exec)
    if (rawUrl === undefined) return next()
    const url = await preflightPublicFetchUrl(rawUrl, exec.signal)

    const downstream = await next()
    if (downstream.kind !== 'allow') return downstream
    return {
      kind: 'ask',
      reason: `Allow web_fetch to access ${url.toString()} in ${mode} mode? This permission applies only to this tool call.`,
    }
  })
}
