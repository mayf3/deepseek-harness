/**
 * Durable image offload through the plugin: the routed budget advances the
 * `image/offload` watermark before a step, the watermark never retreats, and
 * an adapter's `IMAGE_OFFLOAD_REQUIRED` failure advances it by the named count
 * and retries the step.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { createUserMessage, IMAGE_OFFLOAD_REQUIRED_CODE, LlmAdapter, LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, LlmImageRequestBudget, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import * as offload from '../src/index.ts'

type ScriptEntry = StreamChunk[] | (() => never)

/** Replies one scripted stream per request and declares an optional request-image budget. */
class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: ScriptEntry[], private readonly imageRequest?: LlmImageRequestBudget) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...this.imageRequest === undefined ? {} : { inputModalities: ['text', 'image'], imageRequest: this.imageRequest },
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('script exhausted')
    if (typeof entry === 'function') entry()
    else yield * entry
  }
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function offloadRequired(offloadImages: number): () => never {
  return () => {
    throw new LlmError('request images exceed the route budget', IMAGE_OFFLOAD_REQUIRED_CODE, { offloadImages })
  }
}

async function harness(adapter: ScriptedAdapter): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(Object.assign((inner: Context) => { offload.apply(inner, {}) }, { inject: offload.inject }))
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function image(name: string, bytes: number): Extract<ContentBlock, { type: 'image' }> {
  return {
    type: 'image',
    attachment: { attachmentId: `sha256:${'a'.repeat(64)}` as never, name, mediaType: 'image/png', bytes, width: 1, height: 1 },
  }
}

function text(value: string): ReturnType<typeof createUserMessage> {
  return createUserMessage({ content: [{ type: 'text', text: value }], source: { kind: 'user' } })
}

function offloadedNames(options: GenerateOptions): string[] {
  const names: string[] = []
  const visit = (blocks: readonly ContentBlock[]): void => {
    for (const block of blocks) {
      if (block.type === 'image' && block.offloaded === true) names.push(block.attachment.name ?? '')
      if (block.type === 'tool-result') visit(block.content)
    }
  }
  for (const message of options.messages) visit(message.content)
  return names
}

function offloadEvents(session: Session): { turn: number; step: number; seq: number; path: number[] }[] {
  return session.snapshotEvents()
    .filter(event => event.type === 'image/offload')
    .map(event => ({
      turn: event.data.turn,
      step: event.data.step,
      seq: Number(event.data.watermark.seq),
      path: event.data.watermark.path,
    }))
}

const budget: LlmImageRequestBudget = { representation: 'raw', maxBytes: 10, byteQuantum: 4 }

describe('llm-image-offload', () => {
  it('advances the watermark before a step from the routed budget and never retreats', async () => {
    const adapter = new ScriptedAdapter([textResponse('one'), textResponse('two'), textResponse('three')], budget)
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('offload-advance'), { provider: 'mock', model: 'mock' })

    // The first turn logs the request header that names the route.
    agent.followup(text('hello'))
    await agent.whenIdle()
    expect(offloadEvents(agent.session)).toHaveLength(0)

    // 12 raw bytes exceed the 10-byte bound by 2, rounded up to one 4-byte quantum: 'a'
    // alone removes 4 bytes but the quantum rule crosses into 'b'.
    agent.session.append('user/message', createUserMessage({
      content: [image('a', 4), { type: 'tool-result', toolCallId: ToolCallId('shot'), content: [image('b', 4)] }, image('c', 4)],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    agent.followup(text('again'))
    await agent.whenIdle()

    expect(offloadedNames(adapter.requests[1]!)).toEqual(['a', 'b'])
    const events = offloadEvents(agent.session)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ turn: 2, step: 1, path: [1, 0] })
    const order = agent.session.snapshotEvents().map(event => event.type)
    expect(order.lastIndexOf('turn/start')).toBeLessThan(order.indexOf('image/offload'))
    expect(order.indexOf('image/offload')).toBeLessThan(order.lastIndexOf('step/start'))

    // The next turn adds no bytes beyond the bound, so the watermark holds and the
    // second request's offloaded set is still what the third request sends.
    agent.followup(text('once more'))
    await agent.whenIdle()
    expect(offloadedNames(adapter.requests[2]!)).toEqual(['a', 'b'])
    expect(offloadEvents(agent.session)).toHaveLength(1)
  })

  it('leaves a route without a declared budget alone', async () => {
    const adapter = new ScriptedAdapter([textResponse('ok'), textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('offload-none'), { provider: 'mock', model: 'mock' })
    agent.followup(text('hello'))
    await agent.whenIdle()
    agent.session.append('user/message', createUserMessage({ content: [image('a', 400)], source: { kind: 'user' } }), { surfaceOp: 'append' })
    agent.followup(text('again'))
    await agent.whenIdle()
    expect(offloadedNames(adapter.requests[1]!)).toEqual([])
    expect(offloadEvents(agent.session)).toHaveLength(0)
  })

  it('advances by the count an IMAGE_OFFLOAD_REQUIRED failure names and retries the step', async () => {
    const adapter = new ScriptedAdapter([offloadRequired(2), textResponse('sent')], { representation: 'raw', maxBytes: 100 })
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('offload-required'), { provider: 'mock', model: 'mock' })
    const delegated: string[] = []
    ctx.on('agent/request-error', ({ failure }, next) => {
      delegated.push(failure.code)
      return next()
    })

    agent.followup(createUserMessage({
      content: [image('a', 1), image('b', 1), image('c', 1)], source: { kind: 'user' },
    }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    expect(offloadedNames(adapter.requests[0]!)).toEqual([])
    expect(offloadedNames(adapter.requests[1]!)).toEqual(['a', 'b'])
    expect(offloadEvents(agent.session)).toEqual([{ turn: 1, step: 1, seq: expect.any(Number) as never, path: [1] }])
    expect(delegated).toEqual([])
    const types = agent.session.snapshotEvents().map(event => event.type)
    expect(types.filter(type => type === 'assistant/attempt')).toHaveLength(1)
    expect(types.filter(type => type === 'assistant/message')).toHaveLength(1)
    expect(types.indexOf('assistant/attempt')).toBeLessThan(types.indexOf('image/offload'))
  })

  it('interprets an adapter count in request order after a surface replacement', async () => {
    const adapter = new ScriptedAdapter([offloadRequired(2), textResponse('sent')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('offload-reordered'), { provider: 'mock', model: 'mock' })
    const first = agent.session.append('user/message', createUserMessage({
      content: [image('first', 1)], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    agent.session.append('user/message', createUserMessage({
      content: [image('second', 1)], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    agent.session.append('user/message', createUserMessage({
      content: [image('replacement', 1)], source: { kind: 'user' },
    }), {
      surfaceOp: { op: 'replace', start: first.seq, end: first.seq },
      sourceEventSeqs: [first.seq],
    })

    agent.followup(text('send'))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    expect(offloadedNames(adapter.requests[1]!)).toEqual(['replacement', 'second'])
    expect(offloadEvents(agent.session).at(-1)).toMatchObject({ seq: 2, path: [0] })
  })

  it('delegates IMAGE_OFFLOAD_REQUIRED once nothing remains to offload', async () => {
    const adapter = new ScriptedAdapter([offloadRequired(1)])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('offload-exhausted'), { provider: 'mock', model: 'mock' })
    const delegated: string[] = []
    ctx.on('agent/request-error', ({ failure }, next) => {
      delegated.push(failure.code)
      return next()
    })
    agent.followup(text('no images'))
    await agent.whenIdle()
    expect(delegated).toEqual([IMAGE_OFFLOAD_REQUIRED_CODE])
    expect(offloadEvents(agent.session)).toHaveLength(0)
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'error' } } })
  })
})
