/** Host fetch observation behavior. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { installFetchObserver, type FetchObserver } from '../src/host/inspection/network.ts'
import type { InspectorRecordInput } from '../src/shared/bridge/messages/observation.ts'
import type { InspectorJsonValue } from '../src/shared/json.ts'

describe('full fetch observer', () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  let observer: FetchObserver | undefined

  afterEach(async () => {
    await observer?.stop()
    observer = undefined
    if (originalDescriptor === undefined) Reflect.deleteProperty(globalThis, 'fetch')
    else Object.defineProperty(globalThis, 'fetch', originalDescriptor)
  })

  it('captures complete URL, headers, request body, response headers, and response body', async () => {
    const records: InspectorRecordInput[] = []
    const native = vi.fn(async (request: Request) => {
      expect(await request.clone().text()).toBe('secret request body')
      return new Response('complete response body', {
        status: 201,
        statusText: 'Created',
        headers: { authorization: 'response secret', 'content-type': 'text/plain' },
      })
    })
    Object.defineProperty(globalThis, 'fetch', { value: native, writable: true, configurable: true })
    observer = installFetchObserver({
      publish(topic: string, payload: InspectorJsonValue, monotonicMs = performance.now()) {
        records.push({ topic, payload, monotonicMs })
      },
    }, { maxRequestBodyBytes: 1_024, maxResponseBodyBytes: 1_024, maxChunkBytes: 4 })

    const response = await fetch('https://example.test/path?token=visible', {
      method: 'POST',
      headers: { authorization: 'Bearer visible' },
      body: 'secret request body',
    })
    expect(await response.text()).toBe('complete response body')
    await vi.waitFor(() => { expect(records.some(record => record.topic === 'fetch/end')).toBe(true) })

    const start = payload(records, 'fetch/start')
    expect(start).toMatchObject({
      url: 'https://example.test/path?token=visible',
      method: 'POST',
    })
    expect(start.headers).toEqual(expect.arrayContaining([['authorization', 'Bearer visible']]))
    expect(decodeChunks(records, 'fetch/request-body-chunk')).toBe('secret request body')
    const responseRecord = payload(records, 'fetch/response')
    expect(responseRecord.status).toBe(201)
    expect(responseRecord.headers).toEqual(expect.arrayContaining([['authorization', 'response secret']]))
    expect(decodeChunks(records, 'fetch/response-body-chunk')).toBe('complete response body')
    expect(payload(records, 'fetch/request-body-end')).toMatchObject({ truncated: false })
    expect(payload(records, 'fetch/end')).toMatchObject({ responseBodyTruncated: false })
  })

  it('marks bodies truncated without changing the caller response', async () => {
    const records: InspectorRecordInput[] = []
    Object.defineProperty(globalThis, 'fetch', {
      value: vi.fn(() => Promise.resolve(new Response('response-long'))),
      writable: true,
      configurable: true,
    })
    observer = installFetchObserver({
      publish(topic: string, payload: InspectorJsonValue, monotonicMs = performance.now()) {
        records.push({ topic, payload, monotonicMs })
      },
    }, { maxRequestBodyBytes: 4, maxResponseBodyBytes: 4, maxChunkBytes: 2 })

    const response = await fetch('https://example.test/', { method: 'POST', body: 'request-long' })
    expect(await response.text()).toBe('response-long')
    await vi.waitFor(() => { expect(records.some(record => record.topic === 'fetch/end')).toBe(true) })

    expect(decodeChunks(records, 'fetch/request-body-chunk')).toBe('requ')
    expect(payload(records, 'fetch/request-body-end')).toMatchObject({ capturedBytes: 4, truncated: true })
    expect(decodeChunks(records, 'fetch/response-body-chunk')).toBe('resp')
    expect(payload(records, 'fetch/end')).toMatchObject({ capturedBytes: 4, responseBodyTruncated: true })
  })

  it('reports cancellation after response headers as a canceled request', async () => {
    const records: InspectorRecordInput[] = []
    Object.defineProperty(globalThis, 'fetch', {
      value: vi.fn(async (request: Request) => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from('first'))
          request.signal.addEventListener('abort', () => {
            controller.error(new DOMException('aborted', 'AbortError'))
          }, { once: true })
        },
      }))),
      writable: true,
      configurable: true,
    })
    observer = installFetchObserver({
      publish(topic: string, payload: InspectorJsonValue, monotonicMs = performance.now()) {
        records.push({ topic, payload, monotonicMs })
      },
    }, { maxRequestBodyBytes: 1_024, maxResponseBodyBytes: 1_024, maxChunkBytes: 4 })
    const abort = new AbortController()

    const response = await fetch('https://example.test/cancel-body', { signal: abort.signal })
    abort.abort()
    await expect(response.text()).rejects.toThrow()
    await vi.waitFor(() => { expect(records.some(record => record.topic === 'fetch/error')).toBe(true) })

    expect(payload(records, 'fetch/error')).toMatchObject({ canceled: true })
    expect(records.some(record => record.topic === 'fetch/end')).toBe(false)
  })
})

function payload(records: readonly InspectorRecordInput[], topic: string): Record<string, unknown> {
  const record = records.find(candidate => candidate.topic === topic)
  expect(record).toBeDefined()
  return record!.payload as Record<string, unknown>
}

function decodeChunks(records: readonly InspectorRecordInput[], topic: string): string {
  return Buffer.concat(records
    .filter(record => record.topic === topic)
    .map(record => Buffer.from(String((record.payload as Record<string, unknown>).data), 'base64')))
    .toString('utf8')
}
