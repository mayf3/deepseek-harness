/** Request conversion and durable replay validation. */
import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createMessage, createToolResultMessage, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { resolveOptions, modelInfo } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import { imagePricing, prepareImages } from '../src/images.ts'
import { readReplay, replayState } from '../src/replay.ts'
import { serialize } from '../src/serialize.ts'
import { MODEL, options, user } from './helpers.ts'

const connection = resolveOptions({})
const call = (id = 'a'): ContentBlock => ({ type: 'tool-call', id: ToolCallId(id), name: 'read', arguments: '{"path":"a"}' })
const assistant = (content: ContentBlock[]) => createAssistantMessage({ content, source: { provider: 'deepseek-messages', model: MODEL } })
const result = (id = 'a', content: ContentBlock[] = [{ type: 'text', text: 'result' }]) => createToolResultMessage({ callId: ToolCallId(id), content, isError: false })
const body = (messages: Message[] = [user()], overrides: Partial<GenerateOptions> = {}) => serialize(
  options({ messages, ...overrides }), connection, messages, new Map(), () => undefined,
)

describe('Messages request conversion', () => {
  it('groups parallel results before ordinary text and keeps tool failure content', () => {
    const messages = [user(), assistant([call(), call('b')]), user('follow-up'), result(), createToolResultMessage({ callId: ToolCallId('b'), content: [{ type: 'text', text: 'permission denied' }], isError: true })]
    expect(body(messages).messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: ['a', 'b'].map(id => ({ type: 'tool_use', id, name: 'read', input: { path: 'a' } })) },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'result' }], is_error: false },
        { type: 'tool_result', tool_use_id: 'b', content: [{ type: 'text', text: 'permission denied' }], is_error: true },
        { type: 'text', text: 'follow-up' },
      ] },
    ])
    expect(messages[2]?.content).toEqual([{ type: 'text', text: 'follow-up' }])
  })

  it('preserves empty results without inventing model-visible output', () => {
    const response = body([user(), assistant([call()]), result('a', [])])
    expect(response.messages[2]?.content[0]).toMatchObject({ content: [] })
    const minimal = createMessage({ role: 'user', source: { kind: 'user' }, content: [{ type: 'tool-result', toolCallId: ToolCallId('a'), content: [{ type: 'text', text: '' }] }] })
    expect(body([assistant([call()]), minimal]).messages[1]?.content[0]).toEqual({ type: 'tool_result', tool_use_id: 'a', content: [] })
  })

  it('collects leading system text and maps tools, stop sequences and explicit output cap', () => {
    const system = createMessage({ role: 'system', source: { kind: 'plugin', plugin: 'test' }, content: [{ type: 'text', text: 'instructions' }] })
    expect(body([system, user()], { system: 'top', maxTokens: 123, stop: ['END'], tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }] })).toMatchObject({
      system: 'top\n\ninstructions', max_tokens: 123, stop_sequences: ['END'], tools: [{ name: 'read', description: 'Read a file', input_schema: { type: 'object' } }],
    })
    expect(() => body([user(), system])).toThrow(/system/)
  })

  it.each(['off', 'low', 'high', 'max'])('maps reasoning effort %s', (effort) => {
    const request = body([user()], { reasoningEffort: ReasoningEffortId(effort) })
    expect(request.thinking.type).toBe(effort === 'off' ? 'disabled' : 'enabled')
    expect(request.output_config).toEqual(effort === 'off' ? undefined : { effort })
  })

  it('disables thinking for titles and refuses ignored temperature or unsupported effort', () => {
    expect(body([user()], { purpose: 'session-title', temperature: 0 })).toMatchObject({ thinking: { type: 'disabled' }, temperature: 0 })
    expect(() => body([user()], { temperature: 0 })).toThrow(/temperature/)
    expect(() => body([user()], { reasoningEffort: ReasoningEffortId('medium') })).toThrow(/effort/)
    const disabled = resolveOptions({ thinking: 'disabled' })
    expect(() => serialize(options({ reasoningEffort: ReasoningEffortId('high') }), disabled, [user()], new Map(), () => undefined)).toThrow(/effort/)
    const capped = resolveOptions({ models: [{ id: MODEL, maxTokens: 321 }] })
    expect(serialize(options(), capped, [user()], new Map(), () => undefined).max_tokens).toBe(321)
  })

  it.each([
    [result()], [assistant([call()])], [assistant([call()]), user()],
    [assistant([call(), call()]), result()],
    [assistant([call()]), result(), result()],
  ])('rejects unmatched or duplicated tool history %#', (...messages) => {
    expect(() => body(messages)).toThrow(/tool/)
  })

  it.each(['{', '[]'])('rejects invalid historical tool input %s', (arguments_) => {
    expect(() => body([assistant([{ type: 'tool-call', id: ToolCallId('a'), name: 'read', arguments: arguments_ }]), result()])).toThrow()
  })

  it('preserves own signed thinking, omits absent signatures and validates durable metadata', () => {
    const content: ContentBlock[] = [{ type: 'reasoning', text: '' }, { type: 'text', text: 'answer' }]
    const source = { provider: 'deepseek-messages', model: MODEL, replayState: replayState(MODEL, [{ type: 'reasoning', signature: 'signed' }, { type: 'text' }]) }
    const message = createAssistantMessage({ content, source })
    expect(body([user(), message, user()]).messages[1]?.content).toEqual([{ type: 'thinking', thinking: '', signature: 'signed' }, { type: 'text', text: 'answer' }])
    expect(body([assistant([{ type: 'reasoning', text: 'foreign thought' }])]).messages[0]?.content).toEqual([{ type: 'thinking', thinking: 'foreign thought' }])
    expect(readReplay(message, 'different-model')).toBeUndefined()
    expect(readReplay(user(), MODEL)).toBeUndefined()
  })

  it.each([
    { response: { kind: 'other', version: 1 }, blocks: [] },
    { response: { kind: 'deepseek-messages', version: 2 }, blocks: [] },
    { response: { kind: 'deepseek-messages', version: 1, model: 'wrong' }, blocks: [] },
    { response: { kind: 'deepseek-messages', version: 1, model: MODEL }, blocks: [] },
    { response: { kind: 'deepseek-messages', version: 1, model: MODEL }, blocks: [{ type: 'tool-call' }] },
    { response: { kind: 'deepseek-messages', version: 1, model: MODEL }, blocks: [{ type: 'reasoning', signature: 3 }] },
  ])('rejects unusable replay state %#', (state) => {
    const message = createAssistantMessage({ content: [{ type: 'reasoning', text: 'think' }], source: { provider: 'deepseek-messages', model: MODEL, replayState: state } })
    expect(() => readReplay(message, MODEL)).toThrow(/replay/)
  })
})

describe('validated configuration', () => {
  it('advertises exact model metadata and allows unlisted text models', () => {
    expect(modelInfo(connection, 'deepseek-messages', MODEL)).toMatchObject({ context: { contextWindow: 1_000_000 }, defaultMaxTokens: 256_000, reasoning: { defaultEffort: 'high' } })
    expect(modelInfo(connection, 'deepseek-messages', 'custom').inputModalities).toEqual(['text'])
    expect(modelInfo(resolveOptions({ thinking: 'disabled' }), 'deepseek-messages', MODEL).reasoning?.efforts).toEqual([{ id: 'off', name: 'off' }])
    expect(resolveOptions({ baseURL: 'https://example.com/anthropic///' }).baseURL).toBe('https://example.com/anthropic')
  })
  it.each([
    { thinking: 'disabled', reasoningEffort: 'high' }, { models: [{ id: '' }] },
    { models: [{ id: 'a' }, { id: 'a' }] }, { models: [{ id: 'a', name: '' }] },
    { maxInlineRequestImageBytes: 1 }, { maxImagesPerRequest: 1 },
    { baseURL: 'ftp://example.com' }, { baseURL: 'https://user:pass@example.com' },
    { baseURL: 'https://example.com/?key=x' }, { baseURL: 'https://example.com/#x' },
    { maxTokens: 0 }, { streamIdleTimeoutMs: 0 },
  ])('rejects invalid composition input %#', (value) => {
    expect(() => resolveOptions(value as Config)).toThrow()
  })
})

describe('inline images', () => {
  const ref: ImageAttachmentRef = { attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), mediaType: 'image/png', width: 1, height: 1, bytes: 3 }
  const image: ContentBlock = { type: 'image', attachment: ref }
  const version: RequestImageAttachment = { attachment: ref, variantId: ImageVariantId(`sha256:${'b'.repeat(64)}`), mediaType: 'image/png', bytes: 3, data: Uint8Array.of(1, 2, 3), width: 1, height: 1, depth: 'uchar', space: 'srgb', hasAlpha: false }
  const access = () => ({ readonlyPath: '/workspace/image.png' })
  const model = 'deepseek-v4-flash-vision-exp'
  // Only the read operation is consumed by image preparation; the transport is mocked, not durable content.
  const attachments = { readImageRequest: async () => version } as unknown as AttachmentStore
  const signal = new AbortController().signal
  it('keeps image bytes inside tool results and deduplicates normalization', async () => {
    const history = [assistant([call()]), result('a', [image, image])]
    const prepared = await prepareImages(history, connection, model, attachments, access, signal)
    expect(prepared.versions.size).toBe(1)
    const request = serialize(options({ model }), connection, prepared.messages, prepared.versions, access)
    expect(request.messages[1]?.content[0]).toMatchObject({ type: 'tool_result', content: [
      { type: 'text', text: expect.stringContaining('/workspace/image.png') as string }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } },
      { type: 'text' }, { type: 'image' },
    ] })
    expect(imagePricing(connection, model, access).priceImages([ref])[0]?.visualTokens).toBeGreaterThan(0)
    expect(imagePricing(connection, MODEL, access).priceImages([ref])[0]?.visualTokens).toBe(0)
  })
  it('offloads an oldest prefix using exact encoded bytes and preserves durable references', async () => {
    const config = resolveOptions({
      maxInlineRequestImageBytes: 4, inlineImageOffloadByteQuantum: 1, maxImagesPerRequest: 2, imageOffloadCountQuantum: 1,
    })
    const history = [result('a', [image, image])]
    const prepared = await prepareImages(history, config, model, attachments, access, signal)
    expect(prepared.messages[0]?.content[0]).toMatchObject({ content: [{ type: 'text' }, { type: 'image' }] })
    expect(history[0]?.content[0]).toMatchObject({ content: [image, image] })
    expect(imagePricing(config, model, access).priceImages([ref, ref]).map(entry => entry.visualTokens)).toEqual([0, expect.any(Number)])
    const large = { readImageRequest: async () => ({ ...version, bytes: 30, data: new Uint8Array(30) }) } as unknown as AttachmentStore
    const exact = await prepareImages([result('a', [image])], config, model, large, access, signal)
    expect(exact.messages[0]?.content[0]).toMatchObject({ content: [{ type: 'text' }] })
  })
  it('rejects unsupported roles and unavailable image capabilities before HTTP', async () => {
    const history = [result('a', [image])]
    await expect(prepareImages(history, connection, MODEL, attachments, access, signal)).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    await expect(prepareImages(history, connection, model, undefined, access, signal)).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    await expect(prepareImages([assistant([image])], connection, model, attachments, access, signal)).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    expect(() => body([result('a', [image])])).toThrow(/image/)
    expect(() => body([assistant([image])])).toThrow(/assistant/)
    expect(() => body([result('a', [{ type: 'reasoning', text: 'bad' }])])).toThrow(/user/)
  })
})
