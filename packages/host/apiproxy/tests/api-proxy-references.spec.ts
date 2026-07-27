/**
 * Reference RPC coverage over the real ApiProxy: addressed Host discovery,
 * canonical session mentions, atomic snapshot preparation before enqueue,
 * and error/cancellation behavior.
 */
import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { formatSessionReferenceMention } from '@deepseek-ai/dsh-session-reference'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import UserInteractionService from '@deepseek-ai/dsh-user-interaction'
import type { RpcRequest, RpcResponse } from '../src/api/rpc.ts'
import { RpcId } from '../src/api/rpc.ts'
import { createApiProxy } from '../src/api-proxy.ts'

const DEFAULTS = { provider: 'p', model: 'm', cwd: '/tmp', workspaceRoot: '/tmp' }
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
  await ctx.plugin(UserInteractionService)
  await ctx.plugin(AgentRegistry)
  ctx.provide('workspace', { list: () => [] } as never)
  return ctx
}

function stubAgent(ctx: Context) {
  const session = ctx.sessions.create(undefined, { meta: { cwd: '/project' } })
  const followup = vi.fn<Agent['followup']>()
  const steer = vi.fn<Agent['steer']>()
  const agent = {
    id: session.id,
    session,
    status: 'idle',
    ctx,
    followup,
    steer,
    cancel: vi.fn(),
  } as unknown as Agent & {
    followup: typeof followup
    steer: typeof steer
  }
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
    ctx.provide('sessionReferences', { listCandidates } as never)
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
    const source = 'source-session' as SessionId
    const mention = formatSessionReferenceMention({ sessionId: source, label: 'Research' })
    let finish!: () => void
    const context = {
      source: { kind: 'plugin' as const, plugin: 'session-reference' },
      content: [{ type: 'text' as const, text: 'snapshot' }],
      placement: 'prompt-prefix' as const,
      meta: {
        kind: 'session-reference',
        version: 1,
        references: [{ sessionId: source, label: 'Research' }],
      },
    }
    const prepare = vi.fn(() => new Promise<{
      content: { type: 'text'; text: string }[]
      contexts: typeof context[]
    }>((resolve) => {
      finish = () => {
        resolve({
          content: [{ type: 'text', text: 'compare @Research now' }],
          contexts: [context],
        })
      }
    }))
    ctx.provide('sessionReferences', { prepare } as never)
    const api = createApiProxy(ctx, DEFAULTS)
    const signal = new AbortController().signal
    const pending = api.sessions.prompt(request({
      sessionId: agent.id,
      content: [{ type: 'text' as const, text: `compare ${mention} now` }],
      mode: 'queue' as const,
    }), signal)
    await Promise.resolve()
    expect(agent.followup).not.toHaveBeenCalled()
    expect(prepare).toHaveBeenCalledWith(
      agent,
      [{ type: 'text', text: 'compare @Research now' }],
      [{ sessionId: source, label: 'Research' }],
      signal,
    )
    finish()
    expect(expectOk(await pending)).toEqual({ accepted: true })
    expect(agent.followup).toHaveBeenCalledTimes(1)
    expect(agent.followup.mock.calls[0]?.[0]).toEqual([
      { type: 'text', text: 'compare @Research now' },
    ])
    expect(agent.followup.mock.calls[0]?.[1]?.source?.kind).toBe('user')
    expect(agent.followup.mock.calls[0]?.[1]?.contexts).toEqual([context])
  })

  it('rejects malformed mentions and preparation failures without enqueueing any prompt', async () => {
    const ctx = await harness()
    const agent = stubAgent(ctx)
    const prepare = vi.fn(() => Promise.reject(new Error('snapshot unavailable')))
    ctx.provide('sessionReferences', { prepare } as never)
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
