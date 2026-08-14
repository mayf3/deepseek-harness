/**
 * Reference RPC coverage over the real ApiProxy: addressed Host discovery,
 * canonical session mentions, atomic snapshot preparation before enqueue,
 * and error/cancellation behavior.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import AgentRegistry, { agentEvents, Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { formatSessionReferenceMention } from '@deepseek-ai/dsh-session-reference'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { RpcRequest, RpcResponse } from '../src/api/rpc.ts'
import { RpcId } from '../src/api/rpc.ts'
import { createApiProxy } from '../src/api-proxy.ts'

const DEFAULTS = { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' }
let nextRpc = 1

function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`reference-${String(nextRpc++)}`), payload }
}

function expectOk<T>(response: RpcResponse<T>): T {
  expect(response.result.ok).toBe(true)
  if (!response.result.ok) throw new Error('unreachable')
  return response.result.value
}

function expectErr<T>(response: RpcResponse<T>): { code: string; message: string } {
  expect(response.result.ok).toBe(false)
  if (response.result.ok) throw new Error('unreachable')
  return response.result.error
}

async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  ctx.provide('workspace', { list: () => [] } as never)
  return ctx
}

function stubAgent(ctx: Context, status: Agent['status'] = 'idle') {
  const session = ctx.sessions.create(undefined, { meta: { cwd: '/project' } })
  const followup = vi.fn<Agent['followup']>()
  const steer = vi.fn<Agent['steer']>()
  const inject = vi.fn<Agent['inject']>()
  const inbox = new Inbox(session, {
    inserted(message) {
      agentEvents(ctx, agent).emit('agent/inbox/inserted', { message })
    },
    discarded(message) {
      agentEvents(ctx, agent).emit('agent/inbox/discarded', { message })
    },
    claimed(message, turn) {
      agentEvents(ctx, agent).emit('agent/inbox/claimed', { message, turn })
    },
  })
  const agent = {
    id: session.id,
    session,
    inbox,
    status,
    ctx,
    followup,
    steer,
    inject,
    cancel: vi.fn(),
  } as unknown as Agent & {
    followup: typeof followup
    steer: typeof steer
    inject: typeof inject
  }
  followup.mockImplementation((message) => { inbox.append('next-turn', message) })
  steer.mockImplementation((message) => { inbox.append('next-step', message) })
  inject.mockImplementation((message) => { inbox.append('next-step', message) })
  ctx.agents.register(agent)
  return agent
}

describe('reference discovery', () => {
  it('addresses the target agent and returns file candidates unchanged', async () => {
    const ctx = await harness()
    const agent = stubAgent(ctx)
    const list = vi.fn(() => Promise.resolve([
      { path: 'src', kind: 'directory' as const },
      { path: 'src/index.ts', kind: 'file' as const },
    ]))
    ctx.provide('fileReferences', { list } as never)
    const api = createApiProxy(ctx, DEFAULTS)
    const signal = new AbortController().signal
    const value = expectOk(await api.references.files(
      request({ sessionId: agent.id, query: 'sr' }),
      signal,
    ))
    expect(value.items).toEqual([
      { path: 'src', kind: 'directory' },
      { path: 'src/index.ts', kind: 'file' },
    ])
    expect(list).toHaveBeenCalledWith(agent, 'sr', signal)
  })

  it('formats metadata candidates as opaque canonical mentions', async () => {
    const ctx = await harness()
    const agent = stubAgent(ctx)
    const source = 'source-session' as SessionId
    const listCandidates = vi.fn(() => Promise.resolve([{
      sessionId: source,
      label: 'Research]',
      cwd: '/project',
      createdAt: 42,
    }]))
    ctx.provide('sessionReferenceResolver', { listCandidates } as never)
    const api = createApiProxy(ctx, DEFAULTS)
    const value = expectOk(await api.references.sessions(
      request({ sessionId: agent.id, query: 'res' }),
      new AbortController().signal,
    ))
    expect(value.items).toEqual([{
      sessionId: source,
      label: 'Research]',
      cwd: '/project',
      createdAt: 42,
      mention: formatSessionReferenceMention({ sessionId: source, label: 'Research]' }),
    }])
    expect(listCandidates).toHaveBeenCalledWith(agent, 'res', undefined, expect.any(AbortSignal))
  })

  it('fails explicitly when a reference capability is not composed', async () => {
    const ctx = await harness()
    const agent = stubAgent(ctx)
    const api = createApiProxy(ctx, DEFAULTS)
    expect(expectErr(await api.references.files(
      request({ sessionId: agent.id, query: '' }),
    )).code).toBe('reference-unavailable')
    expect(expectErr(await api.references.sessions(
      request({ sessionId: agent.id, query: '' }),
    )).code).toBe('reference-unavailable')
  })
})

describe('referenced prompt preparation', () => {
  it('normalizes the visible mention and waits for all context preparation before enqueue', async () => {
    const ctx = await harness()
    const agent = stubAgent(ctx)
    const earlier = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'earlier queued prompt' }],
    })
    agent.followup(earlier)
    const source = 'source-session' as SessionId
    const mention = formatSessionReferenceMention({ sessionId: source, label: 'Research' })
    let finish!: () => void
    const context = createUserMessage({
      source: {
        kind: 'session-reference' as const,
        form: 'recall' as const,
        version: 1 as const,
        references: [{
          sessionId: source,
          label: 'Research',
          capturedThroughSeq: null,
          compacted: false,
          originalMessages: 1,
          retainedMessages: 1,
          omittedMessages: 0,
          omittedBytes: 0,
          truncated: false,
          inputIndex: 0,
        }],
      },
      content: [{ type: 'text' as const, text: 'snapshot' }],
    })
    const prepare = vi.fn(() => new Promise<{
      content: { type: 'text'; text: string }[]
      additionalContext: typeof context
    }>((resolve) => {
      finish = () => {
        resolve({
          content: [{ type: 'text', text: 'compare @Research now' }],
          additionalContext: context,
        })
      }
    }))
    ctx.provide('sessionReferenceResolver', { prepare } as never)
    const api = createApiProxy(ctx, DEFAULTS)
    const signal = new AbortController().signal
    const pending = api.sessions.prompt(request({
      sessionId: agent.id,
      content: [{ type: 'text' as const, text: `compare ${mention} now` }],
      mode: 'queue' as const,
    }), signal)
    await vi.waitFor(() => { expect(prepare).toHaveBeenCalledOnce() })
    expect(agent.followup).toHaveBeenCalledTimes(1)
    expect(prepare).toHaveBeenCalledWith(
      agent,
      [{ type: 'text', text: 'compare @Research now' }],
      [{ sessionId: source, label: 'Research' }],
      signal,
    )
    finish()
    expect(expectOk(await pending)).toEqual({ accepted: true })
    expect(agent.followup).toHaveBeenCalledTimes(2)
    const sent = agent.followup.mock.calls[1]?.[0]
    expect(sent).toMatchObject({
      content: [{ type: 'text', text: 'compare @Research now' }],
      source: { kind: 'user' },
    })
    if (sent === undefined) throw new Error('expected queued prompt')
    const firstBatch = agent.inbox.claim('next-turn', 1)
    const firstDecision = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: firstBatch, turn: 1, step: 1, signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: firstBatch }),
    )
    expect(firstDecision).toEqual({ kind: 'enter', messages: [earlier] })
    const referencedBatch = agent.inbox.claim('next-turn', 2)
    const decision = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: referencedBatch, turn: 2, step: 1, signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: referencedBatch }),
    )
    expect(decision).toEqual({ kind: 'enter', messages: [context, sent] })
    const replay = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: referencedBatch, turn: 2, step: 1, signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: referencedBatch }),
    )
    expect(replay).toEqual({ kind: 'enter', messages: referencedBatch })
  })

  it('inserts prepared session context immediately before steering at admission', async () => {
    const ctx = await harness()
    const agent = stubAgent(ctx)
    const source = 'source-session' as SessionId
    const context = createUserMessage({
      source: {
        kind: 'session-reference' as const,
        form: 'recall' as const,
        version: 1 as const,
        references: [{
          sessionId: source,
          label: 'Research',
          capturedThroughSeq: null,
          compacted: false,
          originalMessages: 1,
          retainedMessages: 1,
          omittedMessages: 0,
          omittedBytes: 0,
          truncated: false,
          inputIndex: 0,
        }],
      },
      content: [{ type: 'text' as const, text: 'snapshot' }],
    })
    ctx.provide('sessionReferenceResolver', {
      prepare: () => Promise.resolve({
        content: [{ type: 'text' as const, text: 'continue @Research' }],
        additionalContext: context,
      }),
    } as never)
    const api = createApiProxy(ctx, DEFAULTS)
    const response = await api.sessions.prompt(request({
      sessionId: agent.id,
      content: [{
        type: 'text' as const,
        text: `continue ${formatSessionReferenceMention({ sessionId: source, label: 'Research' })}`,
      }],
      mode: 'steer' as const,
    }))
    expect(expectOk(response)).toEqual({ accepted: true })
    const steered = agent.steer.mock.calls[0]?.[0]
    expect(steered?.content).toEqual([{ type: 'text', text: 'continue @Research' }])
    expect(steered?.source.kind).toBe('user')
    if (steered === undefined) throw new Error('expected steering prompt')
    const signal = new AbortController().signal
    const batch = agent.inbox.claim('next-step', 1)
    const decision = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: batch, turn: 1, step: 1, signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: batch }),
    )
    expect(decision).toEqual({ kind: 'enter', messages: [context, steered] })
    expect(agent.inject).not.toHaveBeenCalled()
  })

  it('keeps prepared context paired when a queued prompt moves to steering', async () => {
    const ctx = await harness()
    const agent = stubAgent(ctx, 'running')
    const source = 'source-session' as SessionId
    const context = createUserMessage({
      source: {
        kind: 'session-reference' as const,
        form: 'recall' as const,
        version: 1 as const,
        references: [{
          sessionId: source,
          label: 'Research',
          capturedThroughSeq: null,
          compacted: false,
          originalMessages: 1,
          retainedMessages: 1,
          omittedMessages: 0,
          omittedBytes: 0,
          truncated: false,
          inputIndex: 0,
        }],
      },
      content: [{ type: 'text' as const, text: 'snapshot' }],
    })
    ctx.provide('sessionReferenceResolver', {
      prepare: () => Promise.resolve({
        content: [{ type: 'text' as const, text: 'continue @Research' }],
        additionalContext: context,
      }),
    } as never)
    const api = createApiProxy(ctx, DEFAULTS)
    expect(expectOk(await api.sessions.prompt(request({
      sessionId: agent.id,
      content: [{
        type: 'text' as const,
        text: formatSessionReferenceMention({ sessionId: source, label: 'Research' }),
      }],
      mode: 'queue' as const,
    })))).toEqual({ accepted: true })
    const queued = agent.inbox.nextTurn[0]
    if (queued === undefined) throw new Error('expected queued reference prompt')

    expect(expectOk(await api.sessions.updateQueue(request({
      sessionId: agent.id,
      itemId: queued.id,
      action: { kind: 'steer' as const },
    })))).toEqual({ accepted: true })
    expect(agent.inbox.nextTurn).toEqual([])
    expect(agent.inbox.nextStep).toEqual([queued])

    const signal = new AbortController().signal
    const batch = agent.inbox.claim('next-step', 1)
    const decision = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: batch, turn: 1, step: 1, signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: batch }),
    )
    expect(decision).toEqual({ kind: 'enter', messages: [context, queued] })
  })

  it.each(['queue', 'steer'] as const)(
    'does not deliver a %s prompt when preparation resolves after cancellation',
    async (mode) => {
      const ctx = await harness()
      const agent = stubAgent(ctx)
      const controller = new AbortController()
      const source = 'source-session' as SessionId
      const mention = formatSessionReferenceMention({ sessionId: source, label: 'Research' })
      ctx.provide('sessionReferenceResolver', {
        prepare: async () => {
          controller.abort()
          return {
            content: [{ type: 'text' as const, text: '@Research' }],
            additionalContext: {
              source: {
                kind: 'session-reference' as const,
                form: 'recall' as const,
                version: 1 as const,
                references: [{
                  sessionId: source,
                  label: 'Research',
                  capturedThroughSeq: null,
                  compacted: false,
                  originalMessages: 1,
                  retainedMessages: 1,
                  omittedMessages: 0,
                  omittedBytes: 0,
                  truncated: false,
                  inputIndex: 0,
                }],
              },
              content: [{ type: 'text' as const, text: 'snapshot' }],
            },
          }
        },
      } as never)
      const api = createApiProxy(ctx, DEFAULTS)

      const response = await api.sessions.prompt(request({
        sessionId: agent.id,
        content: [{ type: 'text' as const, text: mention }],
        mode,
      }), controller.signal)

      expect(expectErr(response).code).toBe('cancelled')
      expect(agent.followup).not.toHaveBeenCalled()
      expect(agent.steer).not.toHaveBeenCalled()
      expect(agent.inject).not.toHaveBeenCalled()
    },
  )

  it('rejects malformed mentions and preparation failures without enqueueing any prompt', async () => {
    const ctx = await harness()
    const agent = stubAgent(ctx)
    const prepare = vi.fn(() => Promise.reject(new Error('snapshot unavailable')))
    ctx.provide('sessionReferenceResolver', { prepare } as never)
    const api = createApiProxy(ctx, DEFAULTS)

    const malformed = await api.sessions.prompt(request({
      sessionId: agent.id,
      content: [{ type: 'text' as const, text: '@[bad](dsh-session:not-canonical)' }],
      mode: 'queue' as const,
    }))
    expect(expectErr(malformed).code).toBe('reference-invalid')
    expect(prepare).not.toHaveBeenCalled()
    expect(agent.followup).not.toHaveBeenCalled()

    const mention = formatSessionReferenceMention({
      sessionId: 'source-session' as SessionId,
      label: 'Research',
    })
    const failed = await api.sessions.prompt(request({
      sessionId: agent.id,
      content: [{ type: 'text' as const, text: mention }],
      mode: 'queue' as const,
    }))
    expect(expectErr(failed).code).toBe('reference-failed')
    expect(agent.followup).not.toHaveBeenCalled()
    expect(agent.steer).not.toHaveBeenCalled()
  })
})
