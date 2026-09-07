/**
 * Image offload recovery: an adapter's `IMAGE_OFFLOAD_REQUIRED` failure
 * advances the durable watermark by the named count and retries the step
 * without spending the provider retry budget.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { createAssistantMessage, createUserMessage, IMAGE_OFFLOAD_REQUIRED_CODE, LlmAdapter, LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import * as retry from '../src/index.ts'

type ScriptEntry = StreamChunk[] | (() => never)

/** Replies one scripted stream per request and declares no retry policy. */
class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: ScriptEntry[]) {
    super()
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
  await ctx.plugin(Object.assign((inner: Context) => { retry.apply(inner, {}) }, { inject: retry.inject }))
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function image(name: string): Extract<ContentBlock, { type: 'image' }> {
  return {
    type: 'image',
    attachment: { attachmentId: `sha256:${'a'.repeat(64)}` as never, name, mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
  }
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

describe('image offload recovery', () => {
  it('advances the watermark by the named count and retries without a retry event', async () => {
    const adapter = new ScriptedAdapter([offloadRequired(2), textResponse('sent')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('offload-required'), { provider: 'mock', model: 'mock' })
    const delegated: string[] = []
    ctx.on('agent/request-error', ({ failure }, next) => {
      delegated.push(failure.code)
      return next()
    })

    agent.followup(createUserMessage({
      content: [image('a'), { type: 'tool-result', toolCallId: ToolCallId('shot'), content: [image('b')] }, image('c')],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    expect(offloadedNames(adapter.requests[0]!)).toEqual([])
    expect(offloadedNames(adapter.requests[1]!)).toEqual(['a', 'b'])
    expect(offloadEvents(agent.session)).toMatchObject([{ turn: 1, step: 1, path: [1, 0] }])
    expect(delegated).toEqual([])
    const types = agent.session.snapshotEvents().map(event => event.type)
    expect(types.filter(type => type === 'llm/retry')).toHaveLength(0)
    expect(types.filter(type => type === 'assistant/attempt')).toHaveLength(1)
    expect(types.indexOf('assistant/attempt')).toBeLessThan(types.indexOf('image/offload'))
    expect(types.indexOf('image/offload')).toBeLessThan(types.indexOf('assistant/message'))
  })

  it('counts the adapter prefix in request order after a surface replacement', async () => {
    const adapter = new ScriptedAdapter([offloadRequired(2), textResponse('sent')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('offload-reordered'), { provider: 'mock', model: 'mock' })
    const first = agent.session.append('user/message', createUserMessage({
      content: [image('first')], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    agent.session.append('user/message', createUserMessage({
      content: [image('second')], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    // An empty-content assistant node derives no message and carries no occurrence.
    agent.session.append('assistant/message', {
      turn: 0,
      step: 0,
      message: createAssistantMessage({ content: [], source: { provider: 'mock', model: 'mock' } }),
      stream: [],
    }, { surfaceOp: 'append' })
    agent.session.append('user/message', createUserMessage({
      content: [image('replacement')], source: { kind: 'user' },
    }), {
      surfaceOp: { op: 'replace', start: first.seq, end: first.seq },
      sourceEventSeqs: [first.seq],
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'send' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    expect(offloadedNames(adapter.requests[1]!)).toEqual(['replacement', 'second'])
    // The replacement node carries the newest seq, so it is the greatest position in the prefix.
    expect(offloadEvents(agent.session).at(-1)).toMatchObject({ seq: 3, path: [0] })
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
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'no images' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(delegated).toEqual([IMAGE_OFFLOAD_REQUIRED_CODE])
    expect(offloadEvents(agent.session)).toHaveLength(0)
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'error' } } })
  })
})
