/** Stagehand structured inference through the initiating Session's registered DSH model. */

import type { ClientLLM } from '@browserbasehq/stagehand'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BlockAssembler, createMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, GenerateOptions, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'

type GenerationParams = Parameters<ClientLLM['generate']>[0]
type GenerationResult = Awaited<ReturnType<ClientLLM['generate']>>
type RecordedRequest = Omit<GenerateOptions, 'signal'>

/** Exact auxiliary inference request, excluding live cancellation and provider credentials. */
export interface StagehandLlmRequest {
  /** Stagehand's required structured response fields. */
  responseFormat: Extract<GenerationParams['responseFormat'], { type: 'json_schema' }>
  /** Complete DSH request logged before its registration-bound dispatch. */
  request: RecordedRequest
}

/** Settled auxiliary output retained independently of the main conversation response. */
export interface StagehandLlmResult {
  /** Sequence of the corresponding pre-dispatch request. */
  requestSeq: SessionSeq
  /** Fully assembled model output, including an invalid or refused result. */
  blocks: ContentBlock[]
  /** Provider terminal outcome. */
  finish: FinishReason
  /** Reported token accounting, when available. */
  usage?: TokenUsage
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Log-only Stagehand model request committed before inference. */
    'browser-use/stagehand-llm-request': StagehandLlmRequest
    /** Log-only Stagehand model response committed before browser automation resumes. */
    'browser-use/stagehand-llm-result': StagehandLlmResult
  }
}

const RESULT_TOOL = 'stagehand_result'
const RESULT_INSTRUCTION = `Return the requested structured result by calling ${RESULT_TOOL} exactly once. Put the result in its result argument. Do not emit a text answer or call another tool.`

/**
 * Satisfy one Stagehand structured generation using a single result tool call.
 * Unsupported input blocks, plain-text answers, other calls, truncation, and invalid
 * structured data reject; this adapter does not retry or execute model tool calls.
 * @param ctx - context providing the registered LLM and Session services.
 * @param agent - exact live Agent owning the browser operation.
 * @param params - Stagehand's model input and requested JSON schema.
 * @param maxTokens - configured auxiliary output-token cap.
 * @param signal - cancellation of the browser operation that requested inference.
 * @returns Stagehand's validated structured result and reported token usage.
 */
export async function generateWithSessionModel(
  ctx: Context,
  agent: Agent,
  params: GenerationParams,
  maxTokens: number,
  signal: AbortSignal,
): Promise<GenerationResult> {
  signal.throwIfAborted()
  if (params.responseFormat?.type !== 'json_schema') {
    throw new Error('Stagehand integration supports structured act, observe, and extract inference only')
  }
  const responseFormat = params.responseFormat
  const schema = z.fromJSONSchema(responseFormat.schema as Parameters<typeof z.fromJSONSchema>[0])
  const route = agent.session.requestHeader()?.config ?? agent.options
  if (route.provider === undefined || route.model === undefined) {
    throw new Error('Stagehand inference requires a selected Session model and provider')
  }
  const prepared = await ctx.llm.prepareCall({
    provider: route.provider,
    model: route.model,
    maxTokens,
    ...route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort },
    ...params.temperature === undefined ? {} : { temperature: params.temperature },
    ...params.stopSequences === undefined ? {} : { stop: params.stopSequences },
  }, signal)
  signal.throwIfAborted()
  const messages = params.messages.map(message => createMessage({
    role: message.role,
    source: { kind: 'plugin' as const, plugin: 'browser-use-stagehand-native' },
    content: (Array.isArray(message.content) ? message.content : [message.content]).map((block) => {
      if (block.type !== 'text') throw new Error(`Stagehand structured inference does not support ${block.type} input`)
      return { type: 'text' as const, text: block.text }
    }),
  }))
  const request: RecordedRequest = deepFreeze({
    ...prepared.config,
    sessionId: agent.session.id,
    system: [params.systemPrompt, RESULT_INSTRUCTION].filter(value => value !== undefined).join('\n\n'),
    messages,
    tools: [{
      name: RESULT_TOOL,
      description: 'Return the structured result requested by Stagehand.',
      parameters: {
        type: 'object',
        properties: { result: responseFormat.schema },
        required: ['result'],
        additionalProperties: false,
      },
    }],
  })
  const logged = agent.session.append('browser-use/stagehand-llm-request', { request, responseFormat })
  await ctx.sessions.flush(agent.session)
  signal.throwIfAborted()
  const assembler = new BlockAssembler()
  for await (const chunk of prepared.stream(deepFreeze({ ...request, signal }))) {
    assembler.push(chunk)
  }
  const blocks = assembler.blocks()
  agent.session.append('browser-use/stagehand-llm-result', {
    requestSeq: logged.seq,
    blocks,
    finish: assembler.finish,
    ...assembler.usage === undefined ? {} : { usage: assembler.usage },
  })
  await ctx.sessions.flush(agent.session)
  signal.throwIfAborted()
  if (assembler.finish.kind !== 'tool-calls') {
    throw new Error(`Stagehand inference ended with ${assembler.finish.kind}; expected one structured result tool call`)
  }
  const calls = blocks.filter(block => block.type === 'tool-call')
  if (calls.length !== 1 || calls[0]?.name !== RESULT_TOOL
    || blocks.some(block => block.type !== 'tool-call' && block.type !== 'reasoning')) {
    throw new Error(`Stagehand inference must return exactly one ${RESULT_TOOL} call`)
  }
  const envelope = z.object({ result: z.unknown() }).strict().parse(JSON.parse(calls[0].arguments))
  const structuredContent = z.json().parse(schema.parse(envelope.result))
  return {
    role: 'assistant',
    content: { type: 'text', text: JSON.stringify(structuredContent) },
    outputFormat: 'json_schema',
    structuredContent,
    stopReason: 'stop',
    ...assembler.usage === undefined ? {} : {
      usage: {
        inputTokens: assembler.usage.inputTokens,
        outputTokens: assembler.usage.outputTokens,
        totalTokens: assembler.usage.totalTokens ?? assembler.usage.inputTokens + assembler.usage.outputTokens,
        ...assembler.usage.reasoningTokens === undefined ? {} : { reasoningTokens: assembler.usage.reasoningTokens },
        ...assembler.usage.cacheReadTokens === undefined ? {} : { cachedInputTokens: assembler.usage.cacheReadTokens },
      },
    },
  }
}
