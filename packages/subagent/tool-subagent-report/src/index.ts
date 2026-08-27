/**
 * The child-scoped `report` tool and its usage guidance, installed into every
 * continuable in-process child's unpublished context. Roots, one-shot children,
 * remote providers, and agentless executions never see the registration.
 *
 * @module @deepseek-ai/dsh-tool-subagent-report
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subagent'
import { FIRST_PARTY_SECTION_ORDER } from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'tool-subagent-report'
// The contribution registers only through childCtx.tools and
// childCtx.systemPrompt, but declaring both services makes Loader ordering fail
// at load instead of at the next child materialization.
export const inject = ['subagents', 'tools', 'systemPrompt']

/** Guidance order after every per-tool section a continuable child can carry. */
const REPORT_SECTION_ORDER = FIRST_PARTY_SECTION_ORDER.TOOL_REPORT

/**
 * Install `report` and its usage guidance into one continuable child's scope.
 * Both registrations are owned by that scope and are therefore invisible to the
 * child's parent and siblings.
 * @param childCtx - child-scoped context receiving the tool and the guidance.
 * @param ctx - service context used for delivery.
 * @returns disposer that attempts both child registrations before reporting cleanup failures.
 */
export function installReportTool(
  childCtx: Context,
  ctx: Context,
): () => void {
  const disposeSection = childCtx.systemPrompt.section({
    name: 'tool:report',
    order: REPORT_SECTION_ORDER,
    text: 'Deliver your result with the report tool before you finish: call it once with a self-contained '
      + 'answer. The agent that started you shares your workspace but does not automatically receive your '
      + 'transcript, tool output, or reasoning, so a closing remark such as "done" leaves it nothing it can '
      + 'use. Report earlier as well whenever a partial finding changes what that agent should do next; '
      + 'reporting never ends your turn.',
  })
  let disposeTool: () => void
  try {
    disposeTool = childCtx.tools.register(defineTool({
      name: 'report',
      description:
        'Report selected content to the agent that started you. Call this once before you finish, with a '
        + 'self-contained final result, and earlier for progress or findings that change what that agent does '
        + 'next. That agent shares your workspace but does not automatically receive your transcript, tool '
        + 'output, or reasoning, so finishing your work is not itself a result. Reporting does not end your '
        + 'turn or finish your work, and only your direct parent receives it. If that agent is working, the '
        + 'report steers its nearest step; otherwise it starts a turn. A failed call may still have arrived '
        + 'if a later tool-result hook failed, so do not blindly repeat it.',
      parameters: {
        output: {
          type: 'string',
          required: true,
          description: 'Actionable content for your parent; summarize conclusions and reference relevant shared paths.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            messageId: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `report accepted by the agent that started you as message ${value.messageId}`,
        }],
      },
      async execute(args, exec) {
        const content: ContentBlock[] = [{ type: 'text', text: args.output }]
        // Scope-local resolution guarantees an Agent. The service still verifies
        // its exact live Activation identity at the authority boundary.
        const child = exec.agent as Agent
        const parentId = child.session.header.parentSession
        if (parentId === undefined) throw new Error('report requires a direct parent Agent')
        const messageId = await ctx.subagents.sendMessage(child, parentId, content, { signal: exec.signal })
        return { messageId }
      },
    }))
  } catch (error: unknown) {
    try {
      disposeSection()
    } catch (rollbackError: unknown) {
      throw new AggregateError(
        [error, rollbackError],
        'failed to register the report tool and roll back its prompt guidance',
      )
    }
    throw error
  }
  return () => {
    const failures: unknown[] = []
    for (const dispose of [disposeTool, disposeSection]) {
      try {
        dispose()
      } catch (error: unknown) {
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'failed to revoke report tool and prompt registrations')
    }
  }
}

/**
 * Register the continuable-child contribution.
 * @param ctx - context carrying tools, the system prompt, and the subagent service.
 */
export function apply(ctx: Context): void {
  ctx.subagents.registerContinuableSetup(childCtx => installReportTool(childCtx, ctx))
}
