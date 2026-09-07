/**
 * Durable image offload in the loop: the route budget advances the
 * `image/offload` watermark before dispatch, the watermark never retreats,
 * and an adapter's `IMAGE_OFFLOAD_REQUIRED` failure advances it by the named
 * count and rebuilds the request.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LlmRuntime, { createAssistantMessage, createUserMessage, IMAGE_OFFLOAD_REQUIRED_CODE, LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, LlmImageRequestBudget } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse } from './mock-adapter.ts'

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
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

function offloadedNames(options: GenerateOptions): string[] {
  const names: string[] = []
  for (const message of options.messages) {
    for (const block of message.content) {
      if (block.type === 'image' && block.offloaded === true) names.push(block.attachment.name ?? '')
      if (block.type === 'tool-result') {
        for (const inner of block.content) {
          if (inner.type === 'image' && inner.offloaded === true) names.push(inner.attachment.name ?? '')
        }
      }
    }
  }
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

describe('image/offload in the agent loop', () => {
  it('advances the watermark before dispatch and never retreats when the budget has headroom again', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')], undefined, undefined, budget)
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('offload-advance'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({
      content: [image('a', 4), { type: 'tool-result', toolCallId: ToolCallId('shot'), content: [image('b', 4)] }, image('c', 4)],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    // 12 raw bytes exceed the 10-byte bound by 2, rounded up to one 4-byte quantum: 'a' alone
    // removes 4 bytes but the quantum rule crosses into 'b'.
    expect(offloadedNames(adapter.requests[0]!)).toEqual(['a', 'b'])
    const events = offloadEvents(agent.session)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ turn: 1, step: 1, path: [1, 0] })
    const dispatchOrder = agent.session.snapshotEvents().map(event => event.type)
    expect(dispatchOrder.indexOf('image/offload')).toBeGreaterThan(dispatchOrder.indexOf('request/header'))
    expect(dispatchOrder.indexOf('image/offload')).toBeLessThan(dispatchOrder.indexOf('assistant/message'))

    // An empty-content assistant node derives no message and carries no occurrence.
    agent.session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({ content: [], source: { provider: 'mock', model: 'mock' } }),
      stream: [],
    }, { surfaceOp: 'append' })
    // The next turn adds no bytes beyond the bound, so the watermark holds, and the first
    // request's offloaded set is still what the second request sends.
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(offloadedNames(adapter.requests[1]!)).toEqual(['a', 'b'])
    expect(offloadEvents(agent.session)).toHaveLength(1)
  })

  it('leaves a route without a declared budget alone', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('offload-none'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [image('a', 400)], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(offloadedNames(adapter.requests[0]!)).toEqual([])
    expect(offloadEvents(agent.session)).toHaveLength(0)
  })

  it('advances by the count an IMAGE_OFFLOAD_REQUIRED failure names and rebuilds the request', async () => {
    const adapter = new MockAdapter([
      () => {
        throw new LlmError('inline budget exceeded', IMAGE_OFFLOAD_REQUIRED_CODE, { offloadImages: 2 })
      },
      textResponse('sent'),
    ], undefined, undefined, { representation: 'raw', maxBytes: 100 })
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('offload-required'), { provider: 'mock', model: 'mock' })
    const recoveries: string[] = []
    ctx.on('agent/request-error', async ({ failure }) => {
      recoveries.push(failure.code)
    })

    agent.followup(createUserMessage({
      content: [image('a', 1), image('b', 1), image('c', 1)], source: { kind: 'user' },
    }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    expect(offloadedNames(adapter.requests[0]!)).toEqual([])
    expect(offloadedNames(adapter.requests[1]!)).toEqual(['a', 'b'])
    expect(offloadEvents(agent.session)).toHaveLength(1)
    expect(offloadEvents(agent.session)[0]).toMatchObject({ turn: 1, step: 1, path: [1] })
    expect(recoveries).toEqual([])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')).toHaveLength(1)
  })

  it('interprets an adapter count in request order after a surface replacement', async () => {
    const adapter = new MockAdapter([
      () => {
        throw new LlmError('inline budget exceeded', IMAGE_OFFLOAD_REQUIRED_CODE, { offloadImages: 2 })
      },
      textResponse('sent'),
    ])
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

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'send' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    expect(offloadedNames(adapter.requests[1]!)).toEqual(['replacement', 'second'])
    expect(offloadEvents(agent.session).at(-1)).toMatchObject({ seq: 2, path: [0] })
  })

  it('surfaces IMAGE_OFFLOAD_REQUIRED as an ordinary failure once nothing remains to offload', async () => {
    const adapter = new MockAdapter([
      () => {
        throw new LlmError('still too large', IMAGE_OFFLOAD_REQUIRED_CODE, { offloadImages: 1 })
      },
    ])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('offload-exhausted'), { provider: 'mock', model: 'mock' })
    const recoveries: string[] = []
    ctx.on('agent/request-error', async ({ failure }) => {
      recoveries.push(failure.code)
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'no images' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(recoveries).toEqual([IMAGE_OFFLOAD_REQUIRED_CODE])
    expect(offloadEvents(agent.session)).toHaveLength(0)
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'error' } } })
  })
})
