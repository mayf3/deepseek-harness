/** Account route cancellation uses the real loop, registry, and tool lifecycle. */
import { afterEach, expect, it, vi } from 'vitest'
import type { DeepSeekAccount } from '@deepseek-ai/dsh-deepseek-account'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk, ToolCallId } from '@deepseek-ai/dsh-llm'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as DeepSeek from '../src/index.ts'
import { assemble } from './assemble.ts'

const contexts: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function harness() {
  const ctx = new Context()
  contexts.push(ctx)
  for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry]) {
    await ctx.plugin(plugin)
  }
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(DeepSeek, { protocol: 'chat-completions' })
  return ctx
}

function send(agent: Agent) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
}

class ScriptedAdapter extends LlmAdapter {
  constructor(private run: (request: GenerateOptions) => AsyncIterable<StreamChunk>) { super() }
  override stream(request: GenerateOptions) { return this.run(request) }
}

it.each(['chat-completions', 'messages'] as const)('never falls back to an API key while signed out: %s', async (protocol) => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'fixture-api-key')
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(DeepSeek, { protocol })
  const fetch = vi.spyOn(globalThis, 'fetch')
  const result = await assemble(ctx, { provider: 'deepseek-account', model: 'deepseek-v4-flash', messages: [] })
  expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'ACCOUNT_SIGN_IN_REQUIRED' } })
  expect(fetch).not.toHaveBeenCalled()
})

it.each(['deepseek-account', 'deepseek-official'])('cancels only the active account route during tools: %s', async (provider) => {
  const ctx = await harness()
  const toolEntered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const adapter = new ScriptedAdapter(async function* () {
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('fixture-call'), name: 'wait', arguments: '{}' } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  })
  ctx.on('llm/stream', request => adapter.stream(request))
  const agent = await ctx.agentLoop.create(SessionId(`tools-${provider}`), { provider, model: 'deepseek-v4-flash' })
  ctx.tools.register(defineContentToolFixture({ name: 'wait', description: '', parameters: {}, async execute() {
    toolEntered.resolve(undefined)
    await release.promise
    return [{ type: 'text', text: 'done' }]
  } }))
  send(agent)
  await toolEntered.promise
  expect(agent.activeProvider).toBe(provider)
  agent.inbox.splice('next-turn', Infinity, 0, [createUserMessage({ content: [{ type: 'text', text: 'queued' }], source: { kind: 'user' } })])
  ctx.emit('deepseek-account/signed-out')
  // Changing settings cannot reclassify the already running tool call.
  expect(agent.activeProvider).toBe(provider)
  expect(agent.inbox.nextTurn).toHaveLength(1)
  if (provider === 'deepseek-official') agent.cancel({ kind: 'user' }, { keepInbox: true })
  release.resolve(undefined)
  await agent.whenIdle()
  expect(agent.activeProvider).toBeUndefined()
  expect(agent.inbox.nextTurn).toHaveLength(1)
  expect(agent.session.snapshotEvents().at(-1)?.data).toMatchObject({ reason: { kind: 'aborted', reason: provider === 'deepseek-account'
    ? { kind: 'hook', reason: 'deepseek-account/signed-out' } : { kind: 'user' } } })
})

it.each(['tool', 'retry'])('replaces the active provider only after the next request binds: %s', async (transition) => {
  const ctx = await harness()
  const preparing = Promise.withResolvers<undefined>()
  const proceed = Promise.withResolvers<undefined>()
  const streaming = Promise.withResolvers<AbortSignal>()
  let requests = 0
  ctx.on('agent/request', async (_event, next) => {
    const config = await next()
    if (++requests === 1) return config
    preparing.resolve(undefined)
    await proceed.promise
    return { ...config, provider: 'deepseek-official' }
  })
  ctx.on('agent/request-error', async (_event, next) => { await next(); return { kind: 'retry' } })
  ctx.on('llm/stream', async function* (request) {
    if (request.provider === 'deepseek-account') {
      if (transition === 'retry') {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT', message: 'retry fixture' } } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('switch-call'), name: 'continue', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const signal = request.signal!
    streaming.resolve(signal)
    await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    signal.throwIfAborted()
  })
  ctx.tools.register(defineContentToolFixture({ name: 'continue', description: '', parameters: {}, execute: async () => [{ type: 'text', text: 'done' }] }))
  const agent = await ctx.agentLoop.create(SessionId('switch-provider'), { provider: 'deepseek-account', model: 'deepseek-v4-flash' })
  expect(agent.activeProvider).toBeUndefined()
  send(agent)
  await preparing.promise
  expect(agent.activeProvider).toBe('deepseek-account')
  proceed.resolve(undefined)
  const signal = await streaming.promise
  expect(agent.activeProvider).toBe('deepseek-official')
  ctx.emit('deepseek-account/signed-out')
  expect(signal.aborted).toBe(false)
  agent.cancel({ kind: 'user' })
  await agent.whenIdle()
  expect(agent.activeProvider).toBeUndefined()
})

it('does not infer a provider while the first request is still being prepared', async () => {
  const ctx = await harness()
  const preparing = Promise.withResolvers<undefined>()
  const proceed = Promise.withResolvers<undefined>()
  ctx.on('agent/request', async ({ signal }, next) => {
    preparing.resolve(undefined)
    await proceed.promise
    expect(signal.aborted).toBe(false)
    return next()
  })
  const agent = await ctx.agentLoop.create(SessionId('first-preparation'), { provider: 'deepseek-account', model: 'deepseek-v4-flash' })
  send(agent)
  await preparing.promise
  expect(agent.activeProvider).toBeUndefined()
  ctx.emit('deepseek-account/signed-out')
  proceed.resolve(undefined)
  await agent.whenIdle()
  expect(agent.session.snapshotEvents().at(-1)?.data).toMatchObject({ reason: { kind: 'error', error: { code: 'ACCOUNT_SIGN_IN_REQUIRED' } } })
})


it.each(['chat-completions', 'messages'] as const)('never borrows an account token for a missing API key: %s', async (protocol) => {
  vi.stubEnv('DEEPSEEK_API_KEY', '')
  const ctx = new Context()
  contexts.push(ctx)
  const resolveToken = vi.fn(async () => 'fixture-account-token')
  ctx.provide('deepseekAccount', { resolveToken } as unknown as DeepSeekAccount)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(DeepSeek, { protocol })
  const fetch = vi.spyOn(globalThis, 'fetch')
  const result = await assemble(ctx, { provider: 'deepseek-official', model: 'deepseek-v4-flash', messages: [] })
  expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
  expect(resolveToken).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
})


it('propagates account sign-out to the HTTP request signal', async () => {
  const ctx = await harness()
  ctx.provide('deepseekAccount', { resolveToken: async () => 'fixture-account-token' } as unknown as DeepSeekAccount)
  const started = Promise.withResolvers<AbortSignal>()
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const signal = init!.signal!
    expect(new Headers(init!.headers).get('x-dsh-auth-token')).toBe('fixture-account-token')
    started.resolve(signal)
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(new Error('request aborted', { cause: signal.reason })) }, { once: true })
    })
  })
  const agent = await ctx.agentLoop.create(SessionId('http-abort'), { provider: 'deepseek-account', model: 'deepseek-v4-flash' })
  send(agent)
  const signal = await started.promise
  ctx.emit('deepseek-account/signed-out')
  await agent.whenIdle()
  expect(signal.aborted).toBe(true)
  expect(agent.session.snapshotEvents().at(-1)?.data).toMatchObject({ reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'deepseek-account/signed-out' } } })
})


it('cancels an account child without stopping its API-key parent', async () => {
  const ctx = await harness()
  const parentStarted = Promise.withResolvers<AbortSignal>()
  const childStarted = Promise.withResolvers<AbortSignal>()
  ctx.on('llm/stream', async function* (request) {
    const signal = request.signal!
    if (request.provider === 'deepseek-account') childStarted.resolve(signal)
    else parentStarted.resolve(signal)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    signal.throwIfAborted()
  })
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  const childHandle = await ctx.agents.create({ sessionId: SessionId('child'), parentAgent: parent,
    agentOptions: { provider: 'deepseek-account', model: 'deepseek-v4-flash' } })
  send(parent)
  send(childHandle.agent)
  const [parentSignal, childSignal] = await Promise.all([parentStarted.promise, childStarted.promise])
  ctx.emit('deepseek-account/signed-out')
  await childHandle.agent.whenIdle()
  expect(childSignal.aborted).toBe(true)
  expect(parentSignal.aborted).toBe(false)
  parent.cancel({ kind: 'user' })
  await parent.whenIdle()
})

it('advertises account and API-key models only while their own credential is available', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', '')
  const ctx = await harness()
  let token: string | undefined
  ctx.provide('deepseekAccount', { resolveToken: async (url: string) => url === 'https://api.deepseek.com' ? token : undefined } as DeepSeekAccount)
  expect(await ctx.llm.listModels('deepseek-account')).toEqual([])
  expect(await ctx.llm.listModels('deepseek-official')).toEqual([])
  token = 'fixture-account-token'
  expect(await ctx.llm.listModels('deepseek-account')).not.toHaveLength(0)
  expect(await ctx.llm.listModels('deepseek-official')).toEqual([])
  vi.stubEnv('DEEPSEEK_API_KEY', 'fixture-key')
  expect(await ctx.llm.listModels('deepseek-official')).not.toHaveLength(0)
  token = undefined
  expect(await ctx.llm.listModels('deepseek-account')).toEqual([])
  expect(await ctx.llm.listModels('deepseek-official')).not.toHaveLength(0)
})
