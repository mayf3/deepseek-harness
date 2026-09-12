/** Native browser ownership through real Agent, Session, and ToolRuntime services. */

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ClientLLM } from '@browserbasehq/stagehand'
import type { NativeBrowserConfig } from '../src/native.ts'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import BrowserUseRegistry from '@deepseek-ai/dsh-browser-use'
import { BrowserUseProviderName } from '@deepseek-ai/dsh-browser-use/brand'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as Provider from '../src/index.ts'
import { fixture, resetFixture } from './fixtures/stagehand.ts'

const acquisition = vi.hoisted(() => ({ signal: undefined as AbortSignal | undefined }))

vi.mock('@browserbasehq/stagehand', async () => import('./fixtures/stagehand.ts'))
vi.mock('../src/worker-client.ts', async () => {
  const { openNativeBrowser } = await import('../src/native.ts')
  return {
    openAttachedBrowser(config: NativeBrowserConfig, generate: ClientLLM['generate'], signal: AbortSignal) {
      acquisition.signal = signal
      return openNativeBrowser(config, generate)
    },
  }
})

let ctx: Context
let first: Agent
let second: Agent
let model: StructuredModel

class StructuredModel extends LlmAdapter {
  value: unknown = { extraction: 'Fixture heading' }
  beforeResult?: (options: GenerateOptions) => Promise<void>
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await this.beforeResult?.(options)
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('native-structured'), name: 'stagehand_result', arguments: JSON.stringify({ result: this.value }) } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

beforeEach(async () => {
  resetFixture()
  acquisition.signal = undefined
  ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(BrowserUseRegistry)
  model = new StructuredModel()
  ctx.llm.registerAdapter(['fixture'], model)
  const harness = await mountAgentLoopTestHarness(ctx)
  first = await harness.create(SessionId('stagehand-first'), { provider: 'fixture', model: 'structured' })
  second = await harness.create(SessionId('stagehand-second'), { provider: 'fixture', model: 'structured' })
})

afterEach(async () => { await ctx.fiber.dispose() })

function execute(agent: Agent, suffix: string, args: unknown, signal = new AbortController().signal) {
  return ctx.tools.execute({ agent, name: `stagehand_${suffix}`, arguments: args, callId: ToolCallId(`test-${suffix}`), signal })
}

it('lazily launches distinct browsers and preserves each Session tab state', async () => {
  const provider = ctx.plugin(Provider, { mode: 'launch', executablePath: '/fixture/chromium', headless: false })
  await provider
  expect(fixture.browsers).toEqual([])
  expect(ctx.tools.schemas()).toHaveLength(6)
  expect((await execute(first, 'navigate', { url: 'https://first.example' })).isError).toBe(false)
  expect((await execute(second, 'navigate', { url: 'https://second.example' })).isError).toBe(false)
  expect(fixture.browsers).toHaveLength(2)
  expect(fixture.browsers[0]?.options).toEqual({ executablePath: '/fixture/chromium', headless: false })
  expect(fixture.browsers.map(browser => browser.active.currentURL)).toEqual(['https://first.example', 'https://second.example'])
  expect((await execute(first, 'tabs', { action: 'new', url: 'https://new.example' })).isError).toBe(false)
  expect((await execute(first, 'tabs', { action: 'select', pageId: 'tab-1' })).isError).toBe(false)
  expect((await execute(first, 'tabs', { action: 'close', pageId: 'tab-2' })).isError).toBe(false)
  expect((await execute(first, 'tabs', { action: 'list' })).content).toEqual([{ type: 'text', text: '{"tabs":[{"pageId":"tab-1","url":"https://first.example","title":"Fixture heading","active":true}]}' }])
  await provider.dispose()
  expect(fixture.browsers.every(browser => browser.closed && browser.stagehandClosed)).toBe(true)
  expect(ctx.browserUse.providerName).toBeUndefined()
  expect(ctx.tools.schemas()).toEqual([])
})

it('reserves an attached browser for one live owner and rejects model connection overrides', async () => {
  await ctx.plugin(Provider, { mode: 'attach', cdpEndpoint: 'http://localhost:9222', extensionId: 'fixture-extension' })
  expect((await execute(first, 'tabs', { action: 'list' })).isError).toBe(false)
  expect((await execute(second, 'tabs', { action: 'list' })).isError).toBe(true)
  expect(fixture.browsers).toHaveLength(1)
  expect(fixture.browsers[0]?.options).toEqual({ cdpUrl: 'http://localhost:9222', extensionId: 'fixture-extension' })
  expect((await execute(first, 'navigate', { url: 'https://example.com', cdpEndpoint: 'http://other' })).isError).toBe(true)
  expect((await execute(first, 'act', { instruction: 'click', model: 'other' })).isError).toBe(true)
})

it('uses the structured callback for actions, observations, and a caller-selected extraction schema', async () => {
  await ctx.plugin(Provider, { mode: 'launch' })
  expect((await execute(first, 'act', { instruction: 'Click the fixture button' })).isError).toBe(false)
  expect((await execute(first, 'observe', { instruction: 'Find the fixture heading' })).isError).toBe(false)
  model.value = { heading: 'Fixture heading' }
  const extraction = await execute(first, 'extract', {
    instruction: 'Extract the heading',
    schema: { type: 'object', properties: { heading: { type: 'string' } }, required: ['heading'] },
  })
  expect(extraction.isError).toBe(false)
  expect(JSON.stringify(extraction.content)).toContain('Fixture heading')
  fixture.actResult = { success: false, message: 'Fixture button unavailable' }
  model.value = { extraction: 'Missing button' }
  const refused = await execute(first, 'act', { instruction: 'Click the missing button' })
  expect(refused.isError).toBe(true)
  expect(JSON.stringify(refused.content)).toContain('Fixture button unavailable')
})

it('refuses unavailable tabs and calls without an exact live Agent', async () => {
  await ctx.plugin(Provider, { mode: 'launch' })
  expect((await execute(first, 'navigate', { url: 'https://example.com', pageId: 'missing' })).isError).toBe(true)
  expect((await ctx.tools.execute({ name: 'stagehand_tabs', arguments: { action: 'list' }, callId: ToolCallId('agentless'), signal: new AbortController().signal })).isError).toBe(true)
  ctx.tools.register({ name: 'unrelated', description: 'An independent tool.', parameters: { type: 'object' }, output: { schema: { type: 'boolean' }, render: () => [{ type: 'text', text: 'independent' }] }, execute: async () => true })
  const unrelated = await ctx.tools.execute({ agent: first, name: 'unrelated', arguments: {}, callId: ToolCallId('unrelated'), signal: new AbortController().signal })
  expect(unrelated.isError).toBe(false)
})

it('rejects native inference started outside an owned browser operation', async () => {
  fixture.create = async (model) => {
    await model.generate({ messages: [], responseFormat: { type: 'json_schema', name: 'unexpected', schema: { type: 'object' } } })
  }
  await ctx.plugin(Provider, { mode: 'launch' })
  const result = await execute(first, 'tabs', { action: 'list' })
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('active browser tool call')
  expect(fixture.browsers[0]?.closed).toBe(true)
})

it('rolls back the native browser after initialization fails', async () => {
  fixture.createError = new Error('Stagehand extension failed')
  await ctx.plugin(Provider, { mode: 'launch' })
  expect((await execute(first, 'tabs', { action: 'list' })).isError).toBe(true)
  expect(fixture.browsers[0]?.closed).toBe(true)
  delete fixture.createError
  expect((await execute(first, 'tabs', { action: 'list' })).isError).toBe(false)
  expect(fixture.browsers).toHaveLength(2)
})

it('connects to a WebSocket endpoint without a configured extension id', async () => {
  await ctx.plugin(Provider, { mode: 'attach', cdpEndpoint: 'ws://127.0.0.1:9222/devtools/browser/fixture' })
  expect((await execute(first, 'tabs', { action: 'list' })).isError).toBe(false)
  expect(fixture.browsers[0]?.options).toEqual({ cdpUrl: 'ws://127.0.0.1:9222/devtools/browser/fixture' })
})

it('holds the provider reservation until browser cleanup settles', async () => {
  const started: PromiseWithResolvers<void> = Promise.withResolvers()
  const settle: PromiseWithResolvers<void> = Promise.withResolvers()
  fixture.browserClose = async () => { started.resolve(); await settle.promise }
  const provider = ctx.plugin(Provider, { mode: 'launch' })
  await provider
  await execute(first, 'tabs', { action: 'list' })
  const closing = provider.dispose()
  try {
    await started.promise
    expect(ctx.tools.schemas()).toEqual([])
    expect(() => ctx.browserUse.register(BrowserUseProviderName('other'))).toThrow('already registered')
  } finally {
    settle.resolve()
    await closing
  }
  expect(ctx.browserUse.providerName).toBeUndefined()
})

it('cancels queued work without navigating while an earlier call settles', async () => {
  const started: PromiseWithResolvers<void> = Promise.withResolvers()
  const settle: PromiseWithResolvers<void> = Promise.withResolvers()
  fixture.navigate = async () => { started.resolve(); await settle.promise }
  await ctx.plugin(Provider, { mode: 'launch' })
  const pending = execute(first, 'navigate', { url: 'https://first.example' })
  await started.promise
  const controller = new AbortController()
  const queued = execute(first, 'navigate', { url: 'https://canceled.example' }, controller.signal)
  controller.abort(new Error('Canceled queued navigation'))
  settle.resolve()
  expect((await pending).isError).toBe(false)
  expect((await queued).isError).toBe(true)
  expect(fixture.browsers[0]?.active.currentURL).toBe('https://first.example')
})

it.each([
  { mode: 'attach' },
  { mode: 'attach', cdpEndpoint: 'invalid endpoint' },
  { mode: 'attach', cdpEndpoint: 'file:///tmp/browser' },
  { mode: 'launch', cdpEndpoint: 'http://localhost:9222' },
  { mode: 'attach', cdpEndpoint: 'http://localhost:9222', executablePath: '/chrome' },
] satisfies Provider.Config[])('rejects inconsistent connection configuration %j before acquiring a browser', async (config) => {
  await expect(ctx.plugin(Provider, config)).rejects.toThrow()
  expect(fixture.browsers).toEqual([])
})

it.each(['dispose', 'disconnect'] as const)('joins model work interrupted by browser %s', async (reason) => {
  const started: PromiseWithResolvers<void> = Promise.withResolvers()
  const aborted: PromiseWithResolvers<void> = Promise.withResolvers()
  const release: PromiseWithResolvers<void> = Promise.withResolvers()
  const disconnected: PromiseWithResolvers<void> = Promise.withResolvers()
  const closeStarted: PromiseWithResolvers<void> = Promise.withResolvers()
  fixture.interrupt = disconnected.promise
  fixture.stagehandClose = () => { closeStarted.resolve(); disconnected.resolve() }
  model.beforeResult = async (options) => {
    options.signal!.addEventListener('abort', () => { aborted.resolve() }, { once: true })
    started.resolve()
    await release.promise
  }
  const provider = ctx.plugin(Provider, { mode: 'launch' })
  await provider
  const operation = execute(first, 'extract', { instruction: 'Read the heading' })
  await started.promise
  let operationSettled = false
  void operation.then(() => { operationSettled = true })
  let disposal: Promise<void> | undefined
  let disposalSettled = false
  try {
    if (reason === 'dispose') {
      disposal = provider.dispose().then(() => { disposalSettled = true })
      await closeStarted.promise
    } else disconnected.resolve()
    await aborted.promise
    expect(operationSettled).toBe(false)
    expect(disposalSettled).toBe(false)
  } finally {
    release.resolve()
    await disposal
    expect((await operation).isError).toBe(true)
  }
  expect(first.session.snapshotEvents().some(event => event.type === 'browser-use/stagehand-llm-result')).toBe(true)
})

it.each([
  { shutdownGraceMs: 2 ** 31 },
  { operationTimeoutMs: 2 ** 31 - 10000 },
  { maxOutputTokens: Number.MAX_SAFE_INTEGER + 1 },
])('rejects timer overflow and unsafe token limits %j', (settings) => {
  expect(() => Provider.Config({ mode: 'launch', ...settings })).toThrow()
})

it('releases an attachment whose initialization completes after provider disposal begins', async () => {
  const started: PromiseWithResolvers<void> = Promise.withResolvers()
  const release: PromiseWithResolvers<void> = Promise.withResolvers()
  const aborted: PromiseWithResolvers<void> = Promise.withResolvers()
  fixture.create = async () => { started.resolve(); await release.promise }
  const provider = ctx.plugin(Provider, { mode: 'attach', cdpEndpoint: 'http://fixture' })
  await provider
  const operation = execute(first, 'tabs', { action: 'list' })
  await started.promise
  acquisition.signal!.addEventListener('abort', () => { aborted.resolve() }, { once: true })
  const closing = provider.dispose()
  try {
    await aborted.promise
    release.resolve()
    expect((await operation).isError).toBe(true)
    await closing
    expect(fixture.browsers[0]?.stagehandClosed).toBe(true)
    expect(fixture.browsers[0]?.closed).toBe(false)
  } finally {
    release.resolve()
    await closing
  }
})
