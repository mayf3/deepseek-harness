/** Host Visualizer authority and recoverable preset model-surface installer. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { visualizerSystemPrompt } from './prompt.ts'
import { RecordedWidgetCalls, type AuthorizedWidgetFollowup } from './recorded-calls.ts'
import { registerVisualizerTools } from './tools.ts'
import type { Config, WidgetPromptRequest, WidgetPromptResult } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    visualizer: VisualizerService
  }
}

const MAX_TITLE_BYTES = 256
const MAX_WIDGET_BYTES = 131_072
const MAX_PROMPT_BYTES = 4_096
const DEFAULT_MAX_PROMPTS_PER_MINUTE_PER_AGENT = 4

interface ResolvedConfig {
  readonly maxWidgetBytes: number
  readonly maxPromptBytes: number
  readonly maxPromptsPerMinutePerAgent: number
}

function boundedPositiveSafeInteger(name: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`tool-visualizer: ${name} must be a positive safe integer`)
  if (value > maximum) throw new TypeError(`tool-visualizer: ${name} must not exceed ${maximum}`)
  return value
}

function resolveConfig(config: Config): ResolvedConfig {
  return Object.freeze({
    maxWidgetBytes: boundedPositiveSafeInteger(
      'maxWidgetBytes', config.maxWidgetBytes ?? MAX_WIDGET_BYTES, MAX_WIDGET_BYTES,
    ),
    maxPromptBytes: boundedPositiveSafeInteger(
      'maxPromptBytes', config.maxPromptBytes ?? MAX_PROMPT_BYTES, MAX_PROMPT_BYTES,
    ),
    maxPromptsPerMinutePerAgent: boundedPositiveSafeInteger(
      'maxPromptsPerMinutePerAgent',
      config.maxPromptsPerMinutePerAgent ?? DEFAULT_MAX_PROMPTS_PER_MINUTE_PER_AGENT,
      Number.MAX_SAFE_INTEGER,
    ),
  })
}

/** One Host service owns every authority-bearing part of the Visualizer extension. */
export class VisualizerService extends TypertRemoteService {
  static inject = ['agents']

  static Config: z<Config> = z.object({
    maxWidgetBytes: z.number().step(1).min(1).max(MAX_WIDGET_BYTES).default(MAX_WIDGET_BYTES),
    maxPromptBytes: z.number().step(1).min(1).max(MAX_PROMPT_BYTES).default(MAX_PROMPT_BYTES),
    maxPromptsPerMinutePerAgent: z.number().step(1).min(1).default(DEFAULT_MAX_PROMPTS_PER_MINUTE_PER_AGENT),
  })

  private readonly rootCtx: Context
  private readonly maxWidgetBytes: number
  private readonly recordedCalls: RecordedWidgetCalls

  constructor(ctx: Context, config: Config) {
    super(ctx, 'visualizer')
    this.rootCtx = ctx
    const resolved = resolveConfig(config)
    this.maxWidgetBytes = resolved.maxWidgetBytes
    this.recordedCalls = new RecordedWidgetCalls(
      { maxTitleBytes: MAX_TITLE_BYTES, maxPromptBytes: resolved.maxPromptBytes },
      resolved.maxPromptsPerMinutePerAgent,
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
      maxWidgetBytes: this.maxWidgetBytes,
    })
  }

  /**
   * Queue a widget-authored message after Host-side authorization and rate limiting.
   * @param agent - Exact live Agent resolved from the Remote session scope.
   * @param request - Follow-up for one successful interactive widget call.
   * @returns Receipt confirming that the follow-up was queued.
   */
  @Remote('sendPrompt')
  remoteSendPrompt(agent: Agent, request: WidgetPromptRequest): WidgetPromptResult {
    let followup: AuthorizedWidgetFollowup
    try {
      this.requireLiveAgent(agent)
      followup = this.recordedCalls.authorizePrompt(agent, request)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new RemoteError('gateway/bad-request', message, {}, { cause: error })
    }
    agent.followup(createUserMessage({
      content: [{
        type: 'text',
        text: followup.text,
      }],
      source: { kind: 'plugin', plugin: 'visualizer' },
    }))
    return { queued: true }
  }

  private requireLiveAgent(agent: Agent): void {
    if (this.rootCtx.agents.get(agent.id) !== agent) {
      throw new Error('visualizer: Remote request does not target the exact live Agent')
    }
  }
}

export default VisualizerService
