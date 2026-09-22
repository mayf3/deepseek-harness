import { afterEach, expect, it, vi } from 'vitest'
import { lookupIpCountry } from '../src/index.ts'

afterEach(() => { vi.unstubAllGlobals() })

function lookup(maxResponseBytes = 4096, signal = new AbortController().signal) {
  return lookupIpCountry({ endpoint: 'https://country.example/', signal, maxResponseBytes })
}

it.each(['CN', 'US', 'HK', 'MO', 'TW', null])('reads %s without returning the IP address', async (country) => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ country, ip: '203.0.113.1' }))
  vi.stubGlobal('fetch', fetch)
  expect(await lookup()).toBe(country)
  expect(fetch).toHaveBeenCalledWith('https://country.example/', expect.objectContaining({ redirect: 'error' }))
})

it.each([{}, [], null, { country: 1 }, { country: 'China' }, { country: 'cn' }])('rejects invalid country data %j', async (body) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body)))
  await expect(lookup()).rejects.toThrow('country code or null')
})

it('rejects invalid JSON and a response without a body', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('{')).mockResolvedValueOnce(new Response(null)))
  await expect(lookup()).rejects.toThrow(SyntaxError)
  await expect(lookup()).rejects.toThrow('no JSON body')
})

it('returns unknown for HTTP 404 and rejects other HTTP failures', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('missing', { status: 404 }))
    .mockResolvedValueOnce(new Response(null, { status: 429 })))
  expect(await lookup()).toBeNull()
  await expect(lookup()).rejects.toThrow('HTTP 429')
})

it('bounds the complete streamed body and cancels oversized responses', async () => {
  const cancel = vi.fn()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"country":"CN",'))
      controller.enqueue(new TextEncoder().encode('"unused":"large"}'))
    },
    cancel,
  }))))
  await expect(lookup(20)).rejects.toThrow('maxResponseBytes')
  expect(cancel).toHaveBeenCalledOnce()
})

it('accepts a body exactly at the byte limit, across multiple chunks', async () => {
  const body = '{"country":"CN"}'
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body.slice(0, 8)))
      controller.enqueue(new TextEncoder().encode(body.slice(8)))
      controller.close()
    },
  }))))
  expect(await lookup(body.length)).toBe('CN')
})

it('passes cancellation to the transport', async () => {
  const control = new AbortController()
  const failure = new Error('cancelled')
  control.abort(failure)
  const fetch = vi.fn(() => Promise.reject(failure))
  vi.stubGlobal('fetch', fetch)
  await expect(lookup(4096, control.signal)).rejects.toBe(failure)
  expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal: control.signal }))
})
