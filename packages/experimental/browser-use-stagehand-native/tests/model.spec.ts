/** Structured inference uses the real LLM runtime and Session durability checkpoint. */

import { afterEach, beforeEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, FinishReason, GenerateOptions, LlmResolvedModelInfo, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { generateWithSessionModel } from '../src/model.ts'

let ctx: Context
let agent: Agent
let model: ResultModel

const params = {
  messages: [{ role: 'user' as const, content: { type: 'text' as const, text: 'Heading: Example Domain' } }],
  systemPrompt: 'Extract the heading.',
  temperature: 0,
  responseFormat: {
    type: 'json_schema' as const,
    name: 'heading',
    schema: { type: 'object', properties: { heading: { type: 'string' } }, required: ['heading'], additionalProperties: false },
  },
}

class ResultModel extends LlmAdapter {
  requests: GenerateOptions[] = []
  blocks: ContentBlock[] = [{ type: 'tool-call', id: ToolCallId('result'), name: 'stagehand_result', arguments: '{"result":{"heading":"Example Domain"}}' }]
  finish: FinishReason = { kind: 'tool-calls' }
  usage: TokenUsage = { inputTokens: 12, outputTokens: 6, totalTokens: 18, cacheReadTokens: 3 }
  beforeStream?: (options: GenerateOptions) => Promise<void>

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, reasoning: { efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }] } })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    await this.beforeStream?.(options)
    for (const [index, block] of this.blocks.entries()) yield { type: 'block-end', index, block }
    yield { type: 'usage', usage: this.usage }
    yield { type: 'finish', reason: this.finish }
  }
}

beforeEach(async () => {
  ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  model = new ResultModel()
  ctx.llm.registerAdapter(['fixture'], model)
  const harness = await mountAgentLoopTestHarness(ctx)
  agent = await harness.create(SessionId('stagehand-model'), { provider: 'fixture', model: 'structured' })
})

afterEach(async () => { await ctx.fiber.dispose() })

it('flushes the exact auxiliary request before dispatch and its response before returning', async () => {
  const flushed: string[][] = []
  ctx.on('session/flush', (session) => { flushed.push(session.snapshotEvents().map(event => event.type)) })
  model.beforeStream = async (options) => {
    expect(flushed.at(-1)?.at(-1)).toBe('browser-use/stagehand-llm-request')
    const event = agent.session.snapshotEvents().find(event => event.type === 'browser-use/stagehand-llm-request')
    if (event?.type !== 'browser-use/stagehand-llm-request') throw new Error('Missing auxiliary request')
    const { signal: _signal, ...loggedOptions } = options
    expect(event.data.request).toEqual(loggedOptions)
    expect(Object.isFrozen(options.messages)).toBe(true)
    expect(options.tools?.[0]?.parameters).toMatchObject({ properties: { result: params.responseFormat.schema } })
  }
  const result = await generateWithSessionModel(ctx, agent, params, 512, new AbortController().signal)
  expect(result).toMatchObject({ outputFormat: 'json_schema', structuredContent: { heading: 'Example Domain' }, usage: { totalTokens: 18, cachedInputTokens: 3 } })
  expect(flushed.at(-1)?.at(-1)).toBe('browser-use/stagehand-llm-result')
  expect(model.requests[0]).toMatchObject({ provider: 'fixture', model: 'structured', maxTokens: 512, temperature: 0 })
  expect(agent.session.deriveMessages()).toEqual([])
})

it('does not dispatch when the request durability checkpoint fails', async () => {
  ctx.on('session/flush', () => { throw new Error('Storage unavailable') })
  await expect(generateWithSessionModel(ctx, agent, params, 512, new AbortController().signal)).rejects.toThrow('Storage unavailable')
  expect(model.requests).toEqual([])
})

it.each([
  ['a text answer', [{ type: 'text', text: '{"heading":"Example Domain"}' }], { kind: 'stop' }],
  ['missing result', [], { kind: 'tool-calls' }],
  ['another tool', [{ type: 'tool-call', id: ToolCallId('other'), name: 'click', arguments: '{}' }], { kind: 'tool-calls' }],
  ['multiple results', [
    { type: 'tool-call', id: ToolCallId('a'), name: 'stagehand_result', arguments: '{"result":{"heading":"A"}}' },
    { type: 'tool-call', id: ToolCallId('b'), name: 'stagehand_result', arguments: '{"result":{"heading":"B"}}' },
  ], { kind: 'tool-calls' }],
  ['invalid result data', [{ type: 'tool-call', id: ToolCallId('invalid'), name: 'stagehand_result', arguments: '{"result":{"heading":4}}' }], { kind: 'tool-calls' }],
  ['text beside the result', [
    { type: 'tool-call', id: ToolCallId('mixed'), name: 'stagehand_result', arguments: '{"result":{"heading":"A"}}' },
    { type: 'text', text: 'unstructured answer' },
  ], { kind: 'tool-calls' }],
  ['truncated output', [{ type: 'tool-call', id: ToolCallId('short'), name: 'stagehand_result', arguments: '{"result":' }], { kind: 'max-tokens' }],
] satisfies Array<[string, ContentBlock[], FinishReason]>)('refuses %s and preserves the settled model output', async (_label, blocks, finish) => {
  model.blocks = blocks
  model.finish = finish
  await expect(generateWithSessionModel(ctx, agent, params, 512, new AbortController().signal)).rejects.toThrow()
  expect(agent.session.snapshotEvents().at(-1)?.type).toBe('browser-use/stagehand-llm-result')
  expect(model.requests).toHaveLength(1)
})

it('forwards cancellation and waits for the model request to settle', async () => {
  const started = Promise.withResolvers<AbortSignal>()
  const stopped: PromiseWithResolvers<void> = Promise.withResolvers()
  model.beforeStream = async (options) => {
    if (options.signal === undefined) throw new Error('Missing inference cancellation')
    started.resolve(options.signal)
    await new Promise<void>((_resolve, reject) => {
      const abort = () => { stopped.resolve(); reject(options.signal!.reason as Error) }
      options.signal!.addEventListener('abort', abort, { once: true })
      if (options.signal!.aborted) abort()
    })
  }
  const controller = new AbortController()
  const pending = generateWithSessionModel(ctx, agent, params, 512, controller.signal)
  const result = expect(pending).rejects.toThrow('Stopped browser action')
  expect(await started.promise).toBe(controller.signal)
  controller.abort(new Error('Stopped browser action'))
  await stopped.promise
  await result
  expect(agent.session.snapshotEvents().at(-1)?.type).toBe('browser-use/stagehand-llm-result')
})

it('rejects non-text inference inputs before any request is dispatched', async () => {
  await expect(generateWithSessionModel(ctx, agent, {
    ...params,
    messages: [{ role: 'user', content: { type: 'image', mimeType: 'image/png', data: 'AA==' } }],
  }, 512, new AbortController().signal)).rejects.toThrow('does not support image input')
  expect(model.requests).toEqual([])
})

it('uses the latest Session route while preserving Stagehand sampling and partial usage', async () => {
  agent.session.append('request/header', { reason: 'initial', header: { config: { provider: 'fixture', model: 'selected-later', reasoningEffort: ReasoningEffortId('off') } } })
  model.usage = { inputTokens: 2, outputTokens: 3, reasoningTokens: 1 }
  const result = await generateWithSessionModel(ctx, agent, {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Heading: Example Domain' }] }],
    stopSequences: ['END'],
    responseFormat: params.responseFormat,
  }, 300, new AbortController().signal)
  expect(model.requests[0]).toMatchObject({ model: 'selected-later', reasoningEffort: 'off', stop: ['END'], maxTokens: 300 })
  expect(result.usage).toEqual({ inputTokens: 2, outputTokens: 3, totalTokens: 5, reasoningTokens: 1 })
})

it('refuses unsupported generation and an unselected Session model before dispatch', async () => {
  await expect(generateWithSessionModel(ctx, agent, { messages: [] }, 512, new AbortController().signal)).rejects.toThrow('structured act, observe, and extract')
  const unselected = await ctx.agentLoop.create(SessionId('stagehand-no-model'))
  await expect(generateWithSessionModel(ctx, unselected, params, 512, new AbortController().signal)).rejects.toThrow('selected Session model')
  expect(model.requests).toEqual([])
})
