/** Host Visualizer authority and recoverable preset model-surface installer. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { visualizerSystemPrompt } from './prompt.ts'
import { RecordedWidgetCalls } from './recorded-calls.ts'
import { registerVisualizerTools } from './tools.ts'
import type { WidgetPromptRequest } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    visualizer: VisualizerService
  }
}

const MAX_TITLE_BYTES = 256
const MAX_WIDGET_BYTES = 131_072
const MAX_PROMPT_BYTES = 4_096
const MAX_PROMPTS_PER_MINUTE_PER_AGENT = 4

/** One Host service owns every authority-bearing part of the Visualizer extension. */
export class VisualizerService extends TypertRemoteService {
  static inject = ['agents']

  private readonly rootCtx: Context
  private readonly recordedCalls: RecordedWidgetCalls

  constructor(ctx: Context) {
    super(ctx, 'visualizer')
    this.rootCtx = ctx
    this.recordedCalls = new RecordedWidgetCalls(
      { maxTitleBytes: MAX_TITLE_BYTES, maxPromptBytes: MAX_PROMPT_BYTES },
      MAX_PROMPTS_PER_MINUTE_PER_AGENT,
    )
  }

  /**
   * Install the model-facing Visualizer contribution in the caller's preset scope.
   * @param modelCtx - Preset-scoped context that owns the prompt and tool effects.
   */
  installModelSurface(modelCtx: Context): void {
    if (scopeOf(modelCtx) === undefined || modelCtx.agent !== undefined) {
      throw new Error('tool-visualizer: the model contribution requires a scoped context without an Agent')
    }
    modelCtx.systemPrompt.section({
      name: 'tool:visualizer',
      order: modelCtx.systemPrompt.getSectionOrder('TOOL_VISUALIZER'),
      text: context => modelCtx.tools.get('show_widget', context.scope) === undefined
        ? ''
        : visualizerSystemPrompt(),
    })
    registerVisualizerTools(modelCtx, {
      maxTitleBytes: MAX_TITLE_BYTES,
      maxWidgetBytes: MAX_WIDGET_BYTES,
    })
  }

  /**
   * Queue a widget-authored message after Host-side authorization and rate limiting.
   * @param agent - Exact live Agent resolved from the Remote session scope.
   * @param request - Follow-up for one successful interactive widget call.
   */
  @Remote('sendPrompt')
  remoteSendPrompt(agent: Agent, request: WidgetPromptRequest): void {
    let text: string
    try {
      this.requireLiveAgent(agent)
      text = this.recordedCalls.authorizePrompt(agent, request)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new RemoteError('gateway/bad-request', message, {}, { cause: error })
    }
    agent.followup(createUserMessage({
      content: [{
        type: 'text',
        text,
      }],
      source: { kind: 'plugin', plugin: 'visualizer' },
    }))
  }

  private requireLiveAgent(agent: Agent): void {
    if (this.rootCtx.agents.get(agent.id) !== agent) {
      throw new Error('visualizer: Remote request does not target the exact live Agent')
    }
  }
}

export default VisualizerService
