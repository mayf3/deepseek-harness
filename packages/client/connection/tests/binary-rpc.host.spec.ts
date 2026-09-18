import { request } from 'node:http'
import { gunzipSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { describe, expect, it } from 'vitest'
import type { BrowserAuth } from '../src/browser-auth.ts'
import { createWebConnectionRpc } from '../src/client/rpc.ts'
import { bridge } from '../src/http-bridge.ts'
import type { ConnectionRpcResult } from '../src/rpc.ts'
import { HostConnectionService } from '../src/rpc-host.ts'

function binaryResponse(rpcId: string, mutate: (parts: FormData) => void = () => {}): Response {
  const parts = new FormData()
  parts.set('metadata', JSON.stringify({
    type: 'server-response', rpcId, result: { ok: true, value: { offset: 7, data: null } },
    attachments: [{ path: ['data'], codec: 'bytes', part: 'bytes-0' }],
  }))
  parts.set('bytes-0', new Blob([new Uint8Array([0, 128, 255])]))
  mutate(parts)
  return new Response(parts)
}

describe('Connection binary RPC', () => {
  it.each(['gzip', 'none'] as const)('preserves %s configuration through the HTTP bridge', async (compression) => {
    const ctx = new Context()
    try {
      await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0, compression })
      await ctx.plugin((owner) => { new HostConnectionService(owner, [], {} as BrowserAuth) })
      const connection = ctx.get('connection') as HostConnectionService
      const data = new Uint8Array(1024 * 1024).fill(65)
      data.set([0, 128, 255])
      connection.rpc.intercept('/api', endpoint => endpoint === 'fixture/read', async () => ({ ok: true, value: { data, bytes: data.length } }))
      const handler = connection.createSharedFetchHandler('/api')
      ctx.webServer.register({ kind: 'prefix', path: '/api', handler: (req, res) => bridge(req, res, handler) })
      let transferred = 0
      let encoding: string | undefined
      const rpc = createWebConnectionRpc((path, init) => new Promise((resolve, reject) => {
        const req = request(new URL(path, `http://127.0.0.1:${ctx.webServer.port}`), {
          method: init.method,
          headers: { ...Object.fromEntries(new Headers(init.headers)), 'accept-encoding': 'gzip' },
        }, (response) => {
          void (async () => {
            const chunks: Buffer[] = []
            for await (const chunk of response) chunks.push(chunk as Buffer)
            const body = Buffer.concat(chunks)
            transferred = body.length
            encoding = response.headers['content-encoding']
            return new Response(encoding === 'gzip' ? gunzipSync(body) : body, {
              status: response.statusCode!,
              headers: { 'content-type': response.headers['content-type']! },
            })
          })().then(resolve, reject)
        })
        req.once('error', reject)
        req.end(init.body as string)
      }))
      expect(await rpc.call('/api', 'fixture/read', {})).toEqual({ ok: true, value: { data, bytes: data.length } })
      if (compression === 'gzip') {
        expect(encoding).toBe('gzip')
        expect(transferred).toBeLessThan(data.length / 10)
      } else {
        expect(encoding).toBeUndefined()
        expect(transferred).toBeGreaterThan(data.length)
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('roundtrips raw bytes and metadata on the existing channel while JSON results and errors stay JSON', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin((owner) => { new HostConnectionService(owner, [], {} as BrowserAuth) })
    await fiber.await()
    try {
      const connection = ctx.get('connection') as HostConnectionService
      const results: ConnectionRpcResult<unknown>[] = [
        { ok: true, value: { data: new Uint8Array([9, 0, 128, 255, 9]).subarray(1, 4), offset: 7, eof: false, bytes: 42 } },
        { ok: true, value: { data: new Uint8Array(new SharedArrayBuffer(3)).fill(255), offset: 0, eof: true, bytes: 3 } },
        { ok: true, value: { data: new Uint8Array(), offset: 0, eof: true, bytes: 0 } },
        { ok: true, value: { data: 'AID/', encoding: 'base64' } },
        { ok: true, value: { count: 4 } },
        { ok: true, value: null },
        { ok: true, value: 'plain' },
        { ok: false, error: { code: 'fixture/denied', message: 'denied', details: { path: 'private' } } },
      ]
      let next: ConnectionRpcResult<unknown> = results[0]!
      connection.rpc.intercept('/api', endpoint => endpoint === 'fixture/read', async () => next)
      const shared = connection.createSharedFetchHandler('/api')
      const mediaTypes: (string | null)[] = []
      const rpc = createWebConnectionRpc(async (url, init) => {
        const response = await shared.fetch(new Request(new URL(url, 'http://host'), init))
        mediaTypes.push(response.headers.get('content-type'))
        return response
      })
      for (const result of results) {
        next = result
        const received = await rpc.call('/api', 'fixture/read', { args: {} })
        expect(received).toEqual(result)
        if (received.ok && typeof received.value === 'object' && received.value !== null
          && 'data' in received.value && received.value.data instanceof Uint8Array) {
          expect(received.value.data.buffer).toBeInstanceOf(ArrayBuffer)
        }
      }
      expect(mediaTypes.slice(0, 3).every(type => type?.startsWith('multipart/form-data;'))).toBe(true)
      expect(mediaTypes.slice(3)).toEqual(Array(5).fill('application/json'))
    } finally {
      await fiber.dispose()
    }
  })

  it('uses owner result codecs without putting their callbacks on the wire', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin((owner) => { new HostConnectionService(owner, [], {} as BrowserAuth) })
    await fiber.await()
    try {
      const connection = ctx.get('connection') as HostConnectionService
      const content = Buffer.from([9, 0, 128, 255, 9]).subarray(1, 4)
      let reads = 0
      const value = { content, metadata: { get count() { return ++reads } } }
      connection.rpc.intercept('/api', () => true, async () => ({
        ok: true, value,
        encode: (input, writeBytes) => {
          expect(input).toBe(value)
          return { content: writeBytes(content, ['content']), metadata: value.metadata }
        },
      }))
      const handler = connection.createSharedFetchHandler('/api')
      const rpc = createWebConnectionRpc((url, init) => handler.fetch(new Request(new URL(url, 'http://host'), init)))
      expect(await rpc.call('/api', 'fixture/read', {})).toEqual({
        ok: true, value: { content: new Uint8Array([0, 128, 255]), metadata: { count: 1 } },
      })
      expect(reads).toBe(1)
    } finally {
      await fiber.dispose()
    }
  })

  it.each([
    ['missing bytes', (p: FormData) => { p.delete('bytes-0') }],
    ['text bytes', (p: FormData) => { p.set('bytes-0', 'AID/') }],
    ['missing metadata', (p: FormData) => { p.delete('metadata') }],
    ['file metadata', (p: FormData) => { p.set('metadata', new Blob(['{}'])) }],
    ['duplicate metadata', (p: FormData) => { p.append('metadata', '{}') }],
    ['duplicate bytes', (p: FormData) => { p.append('bytes-0', new Blob()) }],
    ['extra part', (p: FormData) => { p.set('extra', 'unclaimed') }],
    ['invalid JSON', (p: FormData) => { p.set('metadata', '{') }],
    ['invalid envelope', (p: FormData) => { p.set('metadata', '{}') }],
    ...[
      { ok: false, error: { code: 'fixture/error', message: 'failed', details: {} } },
      { ok: true, value: null },
      { ok: true, value: [] },
      { ok: true, value: { data: 'duplicate' } },
    ].map(result => ['invalid result', (p: FormData) => { p.set('metadata', JSON.stringify({
      type: 'server-response', rpcId: 'fixture', result,
    })) }] as const),
  ] satisfies readonly (readonly [string, (parts: FormData) => void])[])('rejects malformed multipart: %s', async (_name, mutate) => {
    const rpc = createWebConnectionRpc(async (_url, init) => {
      const message = JSON.parse(init.body as string) as { rpcId: string }
      return binaryResponse(message.rpcId, mutate)
    })
    await expect(rpc.call('/api', 'fixture/read', {})).rejects.toThrow(/invalid binary response|invalid server-response|JSON/)
  })

  it('rejects a binary response for another request', async () => {
    const rpc = createWebConnectionRpc(async () => binaryResponse('unrelated'))
    await expect(rpc.call('/api', 'fixture/read', {})).rejects.toThrow('rpcId mismatch')
  })

  it('roundtrips nested, optional and root bytes without changing caller objects or reserving field names', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin((owner) => { new HostConnectionService(owner, [], {} as BrowserAuth) })
    await fiber.await()
    try {
      const data = new Uint8Array([0, 128, 255])
      const shared = { content: data }
      const value = {
        files: [{ name: 'a.png', ...shared }, { name: 'b.png', content: Buffer.from([9, 2, 3, 9]).subarray(1, 3) }, { name: 'empty' }],
        'dots./[]': [new Uint8Array(), null, [data]],
        metadata: { attachments: shared },
        ...JSON.parse('{"__proto__":null,"constructor":null}') as object,
      }
      Object.defineProperty(value, '__proto__', { value: data, enumerable: true })
      Object.freeze(value.files)
      Object.freeze(value)
      let next: unknown = value
      const connection = ctx.get('connection') as HostConnectionService
      connection.rpc.intercept('/api', () => true, async () => ({ ok: true, value: next }))
      const handler = connection.createSharedFetchHandler('/api')
      const rpc = createWebConnectionRpc((url, init) => handler.fetch(new Request(new URL(url, 'http://host'), init)))
      expect(await rpc.call('/api', 'fixture/read', {})).toEqual({ ok: true, value: {
        ...value, files: [value.files[0], { name: 'b.png', content: new Uint8Array([2, 3]) }, value.files[2]],
      } })
      expect(value.files[0]?.content).toBe(data)
      expect(shared.content).toBe(data)
      expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
      for (const bytes of [data, Buffer.from([0, 128, 255]), new Uint8Array(new SharedArrayBuffer(3))]) {
        next = bytes
        const response = await rpc.call('/api', 'fixture/read', {})
        expect(response).toEqual({ ok: true, value: new Uint8Array(bytes) })
        if (!response.ok || !(response.value instanceof Uint8Array)) throw new Error('expected root bytes')
        expect(response.value.buffer).toBeInstanceOf(ArrayBuffer)
        expect(Object.isFrozen(response.value)).toBe(false)
      }
      next = [data, [data]]
      expect(await rpc.call('/api', 'fixture/read', {})).toEqual({ ok: true, value: next })
      const circular: { next?: object } = {}
      circular.next = circular
      next = circular
      await expect(rpc.call('/api', 'fixture/read', {})).rejects.toThrow('HTTP 500')
      next = { ordinary: [1, 'base64', null], omitted: undefined, date: new Date('2026-01-01T00:00:00Z') }
      expect(await rpc.call('/api', 'fixture/read', {})).toEqual({ ok: true, value: {
        ordinary: [1, 'base64', null], date: '2026-01-01T00:00:00.000Z',
      } })
      const sparse = [data, , null]
      Object.assign(sparse, { extra: data, '-1': data, '01': data, '1.5': data, Infinity: data })
      next = sparse
      expect(await rpc.call('/api', 'fixture/read', {})).toEqual({ ok: true, value: [data, null, null] })
    } finally {
      await fiber.dispose()
    }
  })

  it.each([
    ['absent table', { attachments: undefined }],
    ['non-array table', { attachments: {} }],
    ['empty table', { attachments: [] }],
    ...[
      null, {}, { path: ['data'], codec: 'numpy', part: 'bytes-0' },
      { path: ['data'], codec: 'bytes', part: 0 },
      { path: ['data'], codec: 'bytes', part: 'metadata' },
      { path: 'data', codec: 'bytes', part: 'bytes-0' },
      ...[['missing'], ['offset', 'child'], ['constructor', 'prototype'], [0], ['files', '0'], ['files', -1], ['files', 0.5], ['files', 1], ['files', false], ['files', null]].map(path => ({ path, codec: 'bytes', part: 'bytes-0' })),
    ].map(attachment => ['invalid attachment', { attachments: [attachment] }] as const),
    ['duplicate part', { attachments: [0, 1].map(() => ({ path: ['data'], codec: 'bytes', part: 'bytes-0' })) }],
    ['duplicate path', { attachments: [0, 1].map(i => ({ path: ['data'], codec: 'bytes', part: `bytes-${i}` })) }],
    ['overlapping path', { attachments: [
      { path: ['data'], codec: 'bytes', part: 'bytes-0' },
      { path: ['data', '0'], codec: 'bytes', part: 'bytes-1' },
    ] }],
    ['occupied placeholder', { result: { ok: true, value: { data: 'AID/' } } }],
  ] satisfies readonly (readonly [string, Record<string, unknown>])[])('rejects malformed attachment metadata: %s', async (_name, overrides) => {
    const rpc = createWebConnectionRpc(async (_url, init) => {
      const { rpcId } = JSON.parse(init.body as string) as { rpcId: string }
      return binaryResponse(rpcId, (parts) => {
        const metadata = JSON.parse(parts.get('metadata') as string) as Record<string, unknown>
        parts.set('metadata', JSON.stringify({ ...metadata, result: { ok: true, value: { data: null, offset: 7, files: [null] } }, ...overrides }))
        if (_name === 'duplicate path' || _name === 'overlapping path') parts.set('bytes-1', new Blob())
      })
    })
    await expect(rpc.call('/api', 'fixture/read', {})).rejects.toThrow('invalid binary response')
  })

  it('preserves JSON accessor and toJSON evaluation while reading all array indices', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin((owner) => { new HostConnectionService(owner, [], {} as BrowserAuth) })
    await fiber.await()
    try {
      let reads = 0
      let next: unknown = { get count() { return ++reads } }
      const connection = ctx.get('connection') as HostConnectionService
      connection.rpc.intercept('/api', () => true, async () => ({ ok: true, value: next }))
      const handler = connection.createSharedFetchHandler('/api')
      const rpc = createWebConnectionRpc((url, init) => handler.fetch(new Request(new URL(url, 'http://host'), init)))
      const read = () => rpc.call('/api', 'fixture/read', {})
      expect(await read()).toEqual({ ok: true, value: { count: 1 } })
      expect(reads).toBe(1)
      const bytes = new Uint8Array([1, 2])
      next = { get content() { reads++; return bytes }, get count() { return ++reads } }
      expect(await read()).toEqual({ ok: true, value: { content: bytes, count: 3 } })
      const array: Uint8Array[] = []
      Object.defineProperty(array, 0, { value: bytes })
      next = array
      expect(await read()).toEqual({ ok: true, value: [bytes] })
      const date = Object.assign(new Date('2026-01-01T00:00:00Z'), { content: bytes })
      next = date
      expect(await read()).toEqual({ ok: true, value: '2026-01-01T00:00:00.000Z' })
      const json = { self: {} as object, toJSON: () => ({ selected: true }) }
      json.self = json
      next = json
      expect(await read()).toEqual({ ok: true, value: { selected: true } })
      let conversions = 0
      next = { toJSON(key: string) { conversions++; expect(key).toBe('value'); return this }, count: 5 }
      expect(await read()).toEqual({ ok: true, value: { count: 5 } })
      expect(conversions).toBe(1)
      for (const primitive of [1, 'text', true]) {
        next = Object(primitive) as object
        expect(await read()).toEqual({ ok: true, value: primitive })
      }
      next = { toJSON: 'ordinary' }
      expect(await read()).toEqual({ ok: true, value: next })
    } finally {
      await fiber.dispose()
    }
  })

  it('rejects truncated multipart and late bytes after caller cancellation', async () => {
    const broken = createWebConnectionRpc(async () => new Response('truncated', {
      headers: { 'content-type': 'multipart/form-data; boundary=fixture' },
    }))
    await expect(broken.call('/api', 'fixture/read', {})).rejects.toThrow()
    const abort = new AbortController()
    const rpc = createWebConnectionRpc(async (_url, init) => {
      const message = JSON.parse(init.body as string) as { rpcId: string }
      abort.abort(new Error('caller left'))
      return binaryResponse(message.rpcId)
    })
    await expect(rpc.call('/api', 'fixture/read', {}, abort.signal)).rejects.toThrow('caller left')
  })
})
