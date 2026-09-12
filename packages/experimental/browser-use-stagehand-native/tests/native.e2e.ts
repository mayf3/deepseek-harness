/** Opt-in installed Stagehand smoke against an owned local page and optional real model. */

import { createServer } from 'node:http'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import BrowserUseRegistry from '@deepseek-ai/dsh-browser-use'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as Provider from '../src/index.ts'

class ImageCapabilities extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] })
  }
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> { throw new Error('Unexpected model call in browser smoke') }
}

it.skipIf(process.env.DSH_STAGEHAND_E2E !== '1')('launches and attaches to installed Chromium while preserving the external browser', { timeout: 120_000, retry: 0 }, async ({ signal }) => {
  const executable = process.env.DSH_BROWSER_EXECUTABLE
  if (executable === undefined) throw new Error('DSH_STAGEHAND_E2E requires DSH_BROWSER_EXECUTABLE')
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end('<!doctype html><title>Stagehand fixture</title><h1>Stagehand local smoke</h1><button onclick="this.textContent=\'Clicked\'">Click fixture</button>')
  })
  const root = await mkdtemp(join(tmpdir(), 'dsh-stagehand-live-'))
  const ctx = new Context()
  let external: ReturnType<typeof spawn> | undefined
  let exited: Promise<unknown> | undefined
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Missing fixture server address')
    const url = `http://127.0.0.1:${address.port}/`
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(BrowserUseRegistry)
    await ctx.plugin(LocalAttachmentStore, { dshHome: root })
    ctx.llm.registerAdapter(['visual-fixture'], new ImageCapabilities())
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('stagehand-live'), { provider: 'visual-fixture', model: 'vision' })
    const execute = (suffix: string, args: unknown) => ctx.tools.execute({
      agent, name: `stagehand_${suffix}`, arguments: args, callId: ToolCallId(`live-${suffix}`), signal,
    })
    const launched = ctx.plugin(Provider, { mode: 'launch', executablePath: executable })
    await launched
    const navigation = await execute('navigate', { url })
    expect(navigation.isError, JSON.stringify(navigation.content)).toBe(false)
    expect(JSON.stringify(navigation.content)).toContain('Stagehand fixture')
    const screenshot = await execute('screenshot', {})
    expect(screenshot.isError, JSON.stringify(screenshot.content)).toBe(false)
    expect(screenshot.content.some(block => block.type === 'image')).toBe(true)
    await launched.dispose()

    external = spawn(executable, [
      '--headless=new', '--remote-debugging-port=0', '--enable-unsafe-extension-debugging', '--remote-allow-origins=*',
      `--user-data-dir=${join(root, 'external-profile')}`, '--no-first-run', '--no-default-browser-check', 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    exited = once(external, 'exit')
    const endpoint = await new Promise<string>((resolve, reject) => {
      let stderr = ''
      external!.stderr!.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
        const match = /DevTools listening on (ws:\/\/[^\s]+)/u.exec(stderr)
        if (match?.[1] !== undefined) resolve(match[1])
      })
      external!.once('error', reject)
      external!.once('exit', (code) => { reject(new Error(`External Chrome exited before readiness (${code}): ${stderr}`)) })
    })
    const attached = ctx.plugin(Provider, { mode: 'attach', cdpEndpoint: endpoint })
    await attached
    const attachedNavigation = await execute('navigate', { url })
    expect(attachedNavigation.isError, JSON.stringify(attachedNavigation.content)).toBe(false)
    const createdUrl = `${url}created-by-tool`
    const created = await execute('tabs', { action: 'new', url: createdUrl })
    expect(created.isError, JSON.stringify(created.content)).toBe(false)
    await attached.dispose()
    expect(external.exitCode).toBeNull()
    const versionUrl = new URL(endpoint)
    versionUrl.protocol = 'http:'
    versionUrl.pathname = '/json/list'
    const targets = await (await fetch(versionUrl, { signal })).json() as Array<{ url: string }>
    expect(targets.some(target => target.url === url)).toBe(true)
    expect(targets.some(target => target.url === createdUrl)).toBe(true)
    const { stdout } = await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL('./fixtures/built-attachment.mjs', import.meta.url)), endpoint, `${url}built-worker`,
    ], { signal, env: {} })
    expect(stdout).toContain('Stagehand local smoke')
    const smoke = JSON.parse(stdout.trim()) as { requests: number; responses: number }
    expect(smoke.requests).toBeGreaterThan(0)
    expect(smoke.responses).toBe(smoke.requests)
    expect(external.exitCode).toBeNull()
    const afterBuilt = await (await fetch(versionUrl, { signal })).json() as Array<{ url: string }>
    expect(afterBuilt.some(target => target.url === `${url}built-worker`)).toBe(true)
  } finally {
    await ctx.fiber.dispose()
    if (external !== undefined && external.exitCode === null) external.kill('SIGTERM')
    await exited
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
    await rm(root, { recursive: true, force: true })
  }
})

it.skipIf(process.env.DSH_STAGEHAND_E2E !== '1' || !process.env.DEEPSEEK_API_KEY)('extracts a controlled heading using Stagehand and the real Session model', { timeout: 120_000, retry: 0 }, async ({ signal }) => {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end('<!doctype html><h1>Stagehand structured result</h1>')
  })
  const ctx = new Context()
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Missing fixture address')
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(BrowserUseRegistry)
    await ctx.plugin(DeepSeek, { reasoningEffort: 'off' })
    await ctx.plugin(Provider, { mode: 'launch', ...process.env.DSH_BROWSER_EXECUTABLE === undefined ? {} : { executablePath: process.env.DSH_BROWSER_EXECUTABLE } })
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('stagehand-real-model'), { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    const execute = (suffix: string, args: unknown) => ctx.tools.execute({ agent, name: `stagehand_${suffix}`, arguments: args, callId: ToolCallId(`api-${suffix}`), signal })
    const navigation = await execute('navigate', { url: `http://127.0.0.1:${address.port}` })
    expect(navigation.isError, JSON.stringify(navigation.content)).toBe(false)
    const result = await execute('extract', {
      instruction: 'Extract the exact h1 heading.',
      schema: { type: 'object', properties: { heading: { type: 'string' } }, required: ['heading'], additionalProperties: false },
    })
    expect(result.isError, JSON.stringify(result.content)).toBe(false)
    expect(JSON.stringify(result.content)).toContain('Stagehand structured result')
    expect(agent.session.snapshotEvents().some(event => event.type === 'browser-use/stagehand-llm-result')).toBe(true)
  } finally {
    await ctx.fiber.dispose()
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
  }
})
