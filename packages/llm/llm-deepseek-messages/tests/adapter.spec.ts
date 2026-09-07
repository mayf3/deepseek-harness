/** HTTP lifecycle, routing and optional Cordis services under real composition. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import LocalAttachments from '@deepseek-ai/dsh-attachment-local'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import FileSettings from '@deepseek-ai/dsh-settings-file'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as Completions from '@deepseek-ai/dsh-llm-deepseek'
import * as Messages from '../src/index.ts'
import { adapter, assemble, chunks, MODEL, options, server, sse, textEvents, user } from './helpers.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})
async function endpoint(...args: Parameters<typeof server>) {
  const instance = await server(...args)
  cleanup.push(() => instance.close())
  return instance
}
async function context() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-messages-test-'))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  vi.stubEnv('DSH_HOME', home)
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  return { ctx, home }
}

describe('direct Messages HTTP', () => {
  it('uses the Messages endpoint, authentication, attribution and final usage', async () => {
    const http = await endpoint()
    const llm = adapter({ baseURL: http.url })
    const response = await assemble(llm.stream(options({ sessionId: SessionId('session-test'), purpose: 'compaction' })))
    expect(response.message.content).toEqual([{ type: 'text', text: 'Hello 世界' }])
    expect(http.requests[0]).toMatchObject({ path: '/anthropic/v1/messages', headers: {
      'x-api-key': 'test-key', 'anthropic-version': '2023-06-01',
      'user-agent': expect.stringContaining('deepseek-harness/') as string, 'x-deepseek-harness-user-id': 'test-user',
      'x-deepseek-harness-session-id': 'session-test', 'x-deepseek-harness-compact': '1',
    }, body: { thinking: { type: 'enabled' }, output_config: { effort: 'high' } } })
    expect(llm.providerInfo('deepseek-messages')).toEqual({ id: 'deepseek-messages', name: 'DeepSeek Messages' })
    expect(await llm.listModels('deepseek-messages')).toHaveLength(3)
    expect(await llm.resolveModel('deepseek-messages', MODEL)).toMatchObject({ id: MODEL })
    expect(llm.imageRequestPricing('deepseek-messages', MODEL)).toBeDefined()
  })

  it.each([true, false])('maps non-2xx responses (JSON=%s)', async (json) => {
    const http = await endpoint((response) => { response.statusCode = 429; response.setHeader('retry-after', '3'); response.end(json ? JSON.stringify({ error: { type: 'rate_limit_error', message: 'slow down' } }) : '<html>busy</html>') })
    await expect(chunks(adapter({ baseURL: http.url }).stream(options()))).rejects.toMatchObject({ code: 'RATE_LIMIT', failure: { status: 429, providerRetryAfterMs: 3000 } })
  })

  it('freezes endpoint and defaults for a prepared call while the next call sees new settings', async () => {
    const first = await endpoint(), second = await endpoint()
    let config = Messages.resolveOptions({ baseURL: first.url, maxTokens: 10 })
    const llm = new Messages.DeepSeekMessagesAdapter({ connection: () => config, apiKey: snapshot => Promise.resolve(snapshot.maxTokens === 10 ? 'first' : 'second'), userId: () => 'user', attachments: () => undefined, imageAccess: () => undefined })
    const prepared = await llm.prepareCall('deepseek-messages', MODEL)
    config = Messages.resolveOptions({ baseURL: second.url, maxTokens: 20 })
    await chunks(prepared.stream(options()))
    await chunks(llm.stream(options()))
    expect(first.requests[0]).toMatchObject({ headers: { 'x-api-key': 'first' }, body: { max_tokens: 10 } })
    expect(second.requests[0]).toMatchObject({ headers: { 'x-api-key': 'second' }, body: { max_tokens: 20 } })
  })

  it('aborts an open provider response when its consumer stops', async () => {
    let closed!: () => void
    const stopped = new Promise<void>((resolve) => { closed = resolve })
    const http = await endpoint((response) => {
      response.once('close', closed)
      response.write(sse(textEvents.slice(0, 3)))
    })
    const stream = adapter({ baseURL: http.url }).stream(options())[Symbol.asyncIterator]()
    expect((await stream.next()).value).toMatchObject({ type: 'block-start' })
    await stream.return!()
    await stopped
  })

  it('distinguishes caller cancellation from idle timeout and transport failure', async () => {
    const http = await endpoint((response) =>{  response.flushHeaders() })
    await expect(chunks(adapter({ baseURL: http.url, streamIdleTimeoutMs: 30 }).stream(options()))).rejects.toMatchObject({ code: 'TIMEOUT' })
    const controller = new AbortController(); controller.abort()
    await expect(chunks(adapter({ baseURL: http.url }).stream(options({ signal: controller.signal })))).rejects.toMatchObject({ code: 'ABORTED' })
    vi.stubGlobal('fetch', async () => { throw new TypeError('network down') })
    await expect(chunks(adapter().stream(options()))).rejects.toMatchObject({ code: 'TRANSPORT' })
  })

  it('rejects a successful response with no readable body', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 200 }))
    await expect(chunks(adapter().stream(options()))).rejects.toMatchObject({ code: 'EMPTY_RESPONSE' })
  })
})

describe('Cordis provider composition', () => {
  it('resolves an attachment service loaded after the adapter and maps its read-only path', async () => {
    const http = await endpoint()
    const { ctx, home } = await context()
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(Messages, { baseURL: http.url })
    const model = 'deepseek-v4-flash-vision-exp'
    const price = () => ctx.llm.imageRequestPricing('deepseek-messages', model)!
    const dummy = { attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), width: 1, height: 1, bytes: 3, mediaType: 'image/png' as const }
    expect(price().priceImages([dummy])[0]?.text).toBeDefined()
    await ctx.plugin(LocalAttachments, { dshHome: home })
    const attachment = await ctx.attachments.saveImage({ data: await readFile(new URL('fixtures/red.png', import.meta.url)), mediaType: 'image/png' })
    expect(price().priceImages([attachment])[0]?.text).not.toContain('/mounted/image.png')
    class MappedFiles extends Service {
      constructor(context: Context) { super(context, 'fs') }
      processPathFromHostPath(_path: string) { return '/mounted/image.png' }
    }
    await ctx.plugin(MappedFiles)
    const message = user()
    await chunks(ctx.llm.stream(options({ model, messages: [{ ...message, content: [...message.content, { type: 'image', attachment }] }] })))
    expect(JSON.stringify(http.requests[0]?.body)).toContain('/mounted/image.png')
    expect(price().priceImages([attachment])[0]?.text).toContain('/mounted/image.png')
  })

  async function boot() {
    const http = await endpoint()
    const { ctx, home } = await context()
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    await writeFile(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: stored-key\n', { mode: 0o600 })
    await writeFile(join(home, 'settings.yaml'), '{}\n')
    const template = await readFile(new URL('fixtures/cordis.yml', import.meta.url), 'utf8')
    await writeFile(join(home, 'cordis.yml'), template.replaceAll('{{endpoint}}', JSON.stringify(http.url)).replaceAll('{{settings}}', JSON.stringify(join(home, 'settings.yaml'))).replaceAll('{{credentials}}', JSON.stringify(join(home, '.credentials.yaml'))))
    ctx.baseUrl = pathToFileURL(home).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-llm', LlmRuntime], ['@deepseek-ai/dsh-llm-deepseek', Completions],
      ['@deepseek-ai/dsh-llm-deepseek-messages', Messages], ['@deepseek-ai/dsh-credentials-local', LocalCredentials], ['@deepseek-ai/dsh-settings-file', FileSettings],
    ])
    // The importer supplies source modules while Loader still owns configuration and effects.
    for (const name of modules.keys()) {
      const directory = join(home, 'node_modules', name)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version: '0.1.3-alpha.1', type: 'module' }))
    }
    ctx.loader.internal = { version: 'v2', async import(name: string) {
      if (!modules.has(name)) throw new Error(`unexpected module ${name}`)
      return modules.get(name)
    } } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(home, 'cordis.yml')).href } })
    await ctx.loader.await()
    return { ctx, http }
  }

  it('loads both routes from YAML, rotates settings and credentials, then removes disposed registrations', async () => {
    const { ctx, http } = await boot()
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(expect.arrayContaining(['deepseek-official', 'deepseek-messages']))
    expect((await assemble(ctx.llm.stream(options()))).assembler.finish.kind).toBe('stop')
    expect(http.requests[0]?.headers['x-api-key']).toBe('stored-key')
    const second = await endpoint()
    await ctx.settings.update(Messages.name, { baseURL: second.url, maxTokens: 51, retryPolicy: { mode: 'always' } })
    await ctx.credentials.set(credentialRef('DEEPSEEK_API_KEY'), 'rotated')
    await chunks(ctx.llm.stream(options()))
    expect(second.requests[0]).toMatchObject({ headers: { 'x-api-key': 'rotated' }, body: { max_tokens: 51 } })
    await ctx.settings.update(Messages.name, { models: [{ id: 'duplicate' }, { id: 'duplicate' }], baseURL: http.url })
    await chunks(ctx.llm.stream(options()))
    expect(second.requests).toHaveLength(2)
    expect(http.requests).toHaveLength(1)
    await ctx.settings.update(Messages.name, { models: [{ id: MODEL }], baseURL: http.url })
    await chunks(ctx.llm.stream(options()))
    expect(http.requests).toHaveLength(2)
    const llm = ctx.llm
    await ctx.fiber.dispose()
    expect(llm.listProviders()).toEqual([])
    expect(llm.listConfigurableProviders()).toEqual([])
  })

  it('uses environment credentials and reports missing or malformed keys without network access', async () => {
    const http = await endpoint()
    const { ctx } = await context()
    vi.stubEnv('DEEPSEEK_MESSAGES_BASE_URL', http.url)
    vi.stubEnv('DEEPSEEK_API_KEY', 'env-key')
    await ctx.plugin(LlmRuntime)
    const fiber = ctx.plugin(Messages)
    await fiber
    await chunks(ctx.llm.stream(options()))
    expect(http.requests[0]?.headers['x-api-key']).toBe('env-key')
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    expect((await assemble(ctx.llm.stream(options()))).assembler.finish).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
    vi.stubEnv('DEEPSEEK_API_KEY', 'bad\nkey')
    expect((await assemble(ctx.llm.stream(options()))).assembler.finish).toMatchObject({ kind: 'error', failure: { code: 'INVALID_CREDENTIAL' } })
    await fiber.dispose()
    expect(ctx.llm.listProviders()).toEqual([])
  })
})
