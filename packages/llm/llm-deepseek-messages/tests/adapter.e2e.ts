/** Real Messages protocol round trips; credentialless CI skips these provider checks. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, LoggerLevel } from '@deepseek-ai/cordis'
import LocalAttachments from '@deepseek-ai/dsh-attachment-local'
import LlmRuntime, { createToolResultMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import * as Messages from '../src/index.ts'
import { assemble, options, user } from './helpers.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
  vi.unstubAllEnvs()
})
async function boot() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-messages-e2e-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  vi.stubEnv('DSH_HOME', home)
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(Messages, { maxTokens: 4096 })
  return ctx
}
const tool = { name: 'lookup_value', description: 'Read the requested value. Always call this tool to obtain a value.', parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } }

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('DeepSeek Messages real API', () => {
  it('describes a durable image sent as inline Messages content', async () => {
    const ctx = await boot()
    await ctx.plugin(LocalAttachments)
    const attachment = await ctx.attachments.saveImage({ data: await readFile(new URL('fixtures/red.png', import.meta.url)), mediaType: 'image/png' })
    const message = user('What is the dominant color of this image? Reply with one English color word.')
    const result = await assemble(ctx.llm.stream(options({
      model: 'deepseek-v4-flash-vision-exp', reasoningEffort: ReasoningEffortId('off'),
      messages: [{ ...message, content: [...message.content, { type: 'image', attachment }] }],
    })))
    expect(result.assembler.finish.kind).toBe('stop')
    expect(result.message.content.filter(block => block.type === 'text').map(block => block.text).join('').toLowerCase()).toContain('red')
  })

  it.each(['off', 'low', 'high', 'max'])('streams text with %s effort', async (effort) => {
    const ctx = await boot()
    const result = await assemble(ctx.llm.stream(options({ reasoningEffort: ReasoningEffortId(effort), messages: [user('Reply with exactly PONG.')] })))
    expect(result.assembler.finish).toEqual({ kind: 'stop' })
    expect(result.message.content.filter(block => block.type === 'text').map(block => block.text).join('')).toContain('PONG')
    expect(result.assembler.usage?.outputTokens).toBeGreaterThan(0)
    expect(result.message.source.replayState).toBeDefined()
  })

  it('replays a JSON-persisted thinking/tool turn and an error result before continuing', async () => {
    const ctx = await boot()
    const history: Message[] = [user('Use lookup_value with key secret. If the tool returns an error, report its exact error text and stop.')]
    const request = options({ messages: history, tools: [tool], reasoningEffort: ReasoningEffortId('high') })
    const first = await assemble(ctx.llm.stream(request))
    expect(first.assembler.finish.kind).toBe('tool-calls')
    const calls = first.message.content.filter(block => block.type === 'tool-call')
    expect(calls).toHaveLength(1)
    const restored = JSON.parse(JSON.stringify(first.message)) as Message
    history.push(restored)
    for (const call of calls) history.push(createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: 'LOOKUP_DENIED_731' }], isError: true }))
    const second = await assemble(ctx.llm.stream({ ...request, messages: history }))
    expect(second.assembler.finish.kind).toBe('stop')
    expect(second.message.content.filter(block => block.type === 'text').map(block => block.text).join('')).toContain('LOOKUP_DENIED_731')
    history.push(second.message, user('Reply with exactly DONE.'))
    const third = await assemble(ctx.llm.stream({ ...request, messages: history }))
    expect(third.assembler.finish.kind).toBe('stop')
  })

  it('cancels an active stream without committing a successful response', async () => {
    const ctx = await boot()
    const controller = new AbortController()
    const stream = ctx.llm.stream(options({ signal: controller.signal, messages: [user('List the integers from one to one thousand, one per line.')] }))
    let cancelled = false
    let finish: unknown
    for await (const chunk of stream) {
      if (!cancelled && (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta')) { cancelled = true; controller.abort() }
      if (chunk.type === 'finish') finish = chunk.reason
    }
    expect(cancelled).toBe(true)
    expect(finish).toMatchObject({ kind: 'aborted' })
  })

  it('continues a thinking/tool turn after degrading unusable persisted replay metadata', async () => {
    const ctx = await boot()
    const warnings: unknown[][] = []
    ctx.logger.exporter({ levels: { default: LoggerLevel.WARN }, export: (message) => { if (message.type === 'warn') warnings.push(message.args) } })
    const history: Message[] = [user('Use lookup_value with key secret. Then reply with the exact tool result and stop.')]
    const request = options({ messages: history, tools: [tool], reasoningEffort: ReasoningEffortId('high') })
    const first = await assemble(ctx.llm.stream(request))
    expect(first.assembler.finish.kind).toBe('tool-calls')
    const calls = first.message.content.filter(block => block.type === 'tool-call')
    expect(calls).toHaveLength(1)
    const restored = JSON.parse(JSON.stringify(first.message)) as typeof first.message
    restored.source.replayState = { response: { kind: 'deepseek-messages', version: 2 }, blocks: [] }
    const saved = JSON.stringify(restored)
    history.push(restored, ...calls.map(call => createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: 'REPLAY_RECOVERED_731' }], isError: false })))
    const second = await assemble(ctx.llm.stream({ ...request, messages: history }))
    expect(second.assembler.finish.kind).toBe('stop')
    expect(second.message.content.filter(block => block.type === 'text').map(block => block.text).join('')).toContain('REPLAY_RECOVERED_731')
    expect(warnings).toEqual([[expect.stringContaining('unsupported kind or version')]])
    expect(JSON.stringify(restored)).toBe(saved)
  })
})
