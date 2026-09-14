import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SubagentRuntime, { type SubagentRunEndInfo } from '../src/index.ts'
import { loadStoredSession } from './persistence-helpers.ts'

it('continues the parent through default Messages after a reasoning-bearing continuable child settles', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-settlement-messages-'))
  const ctx = new Context()
  const requests: { path: string | undefined; body: unknown }[] = []
  const model = 'deepseek-v4-flash'
  const http = createServer((request, response) => {
    void (async () => {
      const parts: Buffer[] = []
      for await (const part of request as AsyncIterable<Buffer>) parts.push(part)
      const body: unknown = JSON.parse(Buffer.concat(parts).toString())
      requests.push({ path: request.url, body })
      const blocks = requests.length === 1
        ? [{ type: 'thinking', thinking: 'child reasoning' }, { type: 'text', text: 'child answer' }]
        : [{ type: 'text', text: 'parent answer' }]
      const events = [
        { type: 'message_start', message: { id: `reply-${requests.length}`, model, usage: { input_tokens: 10, output_tokens: 1 } } },
        ...blocks.flatMap((content_block, index) => [
          { type: 'content_block_start', index, content_block },
          { type: 'content_block_stop', index },
        ]),
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
        { type: 'message_stop' },
      ]
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
    })().catch((error: unknown) => { response.destroy(error as Error) })
  })
  let listening = false
  try {
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject)
      http.listen(0, '127.0.0.1', resolve)
    })
    listening = true
    const address = http.address()
    if (address === null || typeof address === 'string') throw new Error('missing Messages fixture address')
    const connection = resolveAdapterOptions({ baseURL: `http://127.0.0.1:${address.port}/anthropic` })
    const adapter = new DeepSeekAdapter({
      options: () => connection,
      resolveApiKey: () => Promise.resolve('test-key'),
      resolveUserId: () => '00000000-0000-4000-8000-000000000001' as AnonymousUserId,
      prepareExtensions: () => Promise.resolve({ fields: {}, accept: () => Promise.resolve() }),
    })
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    ctx.llm.registerAdapter(['deepseek-official'], adapter)
    const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'deepseek-official', model })
    const ends: SubagentRunEndInfo[] = []
    const settled = Promise.withResolvers<undefined>()
    ctx.on('subagent/end', (info) => {
      ends.push(info)
      settled.resolve(undefined)
    })

    const started = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'child task',
      request: { parent, prompt: [{ type: 'text', text: 'child task' }] },
      signal: new AbortController().signal,
    })
    await settled.promise
    await parent.whenIdle()

    const output = [{ type: 'reasoning', text: 'child reasoning' }, { type: 'text', text: 'child answer' }]
    expect(ends).toHaveLength(1)
    expect(ends[0]?.lastAssistantMessage).toEqual(output)
    const child = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(child.events.filter(event => event.type === 'assistant/message').at(-1))
      .toMatchObject({ data: { message: { content: output } } })
    expect(parent.session.snapshotEvents().at(-1))
      .toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    expect(requests).toHaveLength(2)
    expect(requests.map(request => request.path)).toEqual(['/anthropic/v1/messages', '/anthropic/v1/messages'])
    const notice = parent.session.deriveMessages().find(message => message.source.kind === 'subagent-settled')
    expect(notice?.content).toEqual([
      { type: 'text', text: `Background subagent ${started.childId} finished and will do no further work unless you send it more.` },
      { type: 'text', text: 'Its closing message:' },
      { type: 'text', text: 'child answer' },
    ])
    expect(requests[1]?.body).toMatchObject({ messages: [{ role: 'user', content: notice?.content }] })

    parent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'continue' }] }))
    await parent.whenIdle()
    expect(parent.session.snapshotEvents().filter(event => event.type === 'turn/end'))
      .toMatchObject([{ data: { reason: { kind: 'completed' } } }, { data: { reason: { kind: 'completed' } } }])
    expect(requests).toHaveLength(3)
    expect(requests[2]?.body).toMatchObject({ messages: [
      { role: 'user', content: notice?.content },
      { role: 'assistant', content: [{ type: 'text', text: 'parent answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'continue' }] },
    ] })
  } finally {
    try {
      await ctx.fiber.dispose()
    } finally {
      try {
        if (listening) await new Promise<void>((resolve, reject) => {
          http.close((error) => {
            if (error === undefined) resolve()
            else reject(error)
          })
          http.closeAllConnections()
        })
      } finally {
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      }
    }
  }
})
