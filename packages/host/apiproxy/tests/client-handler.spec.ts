/**
 * Wire-protocol coverage over the isomorphic point: InProcessApiClient →
 * toFetchHandler(scripted impl) runs the real envelope wrap/unwrap, zod
 * two-level parse, and rpcId discipline with no network or browser. Each case
 * scripts its own minimal ApiProxy.
 */

import { describe, expect, it, vi } from 'vitest'
import type { ApiProxy, RpcMessage, RpcRequest, RpcResponse } from '@deepseek-ai/dsh-host-apiproxy'
import { InProcessApiClient, RpcId, toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'

function ok<T>(request: RpcRequest<unknown>, value: T): Promise<RpcResponse<T>> {
  return Promise.resolve({ rpcId: request.rpcId, result: { ok: true, value } })
}

/** Scripted impl: every method resolves an empty-ish OK unless a case overrides it. */
function scriptedApi(overrides: {
  host?: Partial<ApiProxy['host']>
} = {}): ApiProxy {
  return {
    host: {
      describe: r => ok(r, {
        version: '0-test', cwd: '/t', attachedSessions: 0, home: '/h', canOpenPath: true,
      }),
      ...overrides.host,
    },
    downloads: { sessionLog: async () => new Response('stub', { status: 404 }) },
  }
}

function client(api: ApiProxy, timeoutMs?: number): InProcessApiClient {
  return new InProcessApiClient(toFetchHandler(api), timeoutMs)
}

describe('unary round trip', () => {
  it('carries payload out and value back through the full wire form', async () => {
    let seen: RpcRequest<{}> | undefined
    const api = scriptedApi({
      host: {
        describe: (request) => {
          seen = request
          return ok(request, { version: '0-test', cwd: '/t', attachedSessions: 0, home: '/h', canOpenPath: true })
        },
      },
    })
    const response = await client(api).host.describe({})
    expect(seen?.payload).toEqual({})
    expect(seen?.rpcId).toBeTruthy()
    expect(response.rpcId).toBe(seen?.rpcId)
    expect(response.result).toMatchObject({ ok: true, value: { version: '0-test' } })
  })

  it('passes business errors through as 200 + err result, not a throw', async () => {
    const api = scriptedApi({
      host: {
        describe: request => Promise.resolve({
          rpcId: request.rpcId,
          result: { ok: false, error: { code: 'internal', message: 'nope', details: {} } },
        }),
      },
    })
    const response = await client(api).host.describe({})
    expect(response.result).toEqual({ ok: false, error: { code: 'internal', message: 'nope', details: {} } })
  })

  it('throws on rpcId echo mismatch', async () => {
    const api = scriptedApi({
      host: {
        describe: () => Promise.resolve({
          rpcId: RpcId('forged'),
          result: { ok: true, value: { version: '0-test', cwd: '/t', attachedSessions: 0, home: '/h', canOpenPath: true } },
        }),
      },
    })
    await expect(client(api).host.describe({})).rejects.toThrow(/rpcId mismatch/)
  })

  it('rejects a malformed envelope as bad-request, salvaging the rpcId or falling back to the sentinel', async () => {
    const handler = toFetchHandler(scriptedApi())
    // No salvageable rpcId → the fixed invalid-request sentinel keeps the response a valid ServerResponse.
    const noId = await handler.fetch('http://dsh.internal/api/host.describe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonsense: true }) })
    expect(noId.status).toBe(200)
    const noIdParsed = await noId.json() as { rpcId: string; result: { ok: boolean } }
    expect(noIdParsed.result.ok).toBe(false)
    expect(noIdParsed.rpcId).toBe('invalid-request')
    // A string rpcId in the otherwise-bad body is salvaged for correlation.
    const withId = await handler.fetch('http://dsh.internal/api/host.describe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rpcId: 'salvage-me', nonsense: true }) })
    const withIdParsed = await withId.json() as { rpcId: string; result: { ok: boolean } }
    expect(withIdParsed.result.ok).toBe(false)
    expect(withIdParsed.rpcId).toBe('salvage-me')
  })

  it('maps carrier failures to HTTP statuses and the client throws transport failure', async () => {
    const handler = toFetchHandler(scriptedApi())
    // Unknown method → 404.
    const notFound = await handler.fetch('http://dsh.internal/api/no.such', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(notFound.status).toBe(404)
    // Non-JSON body → 400.
    const badBody = await handler.fetch('http://dsh.internal/api/host.describe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' })
    expect(badBody.status).toBe(400)
    // Impl crash → 500, and through the client that is a throw, not an err result.
    const crashing = scriptedApi({ host: { describe: () => { throw new Error('impl exploded') } } })
    await expect(client(crashing).host.describe({})).rejects.toThrow(/transport failure .*500/)
  })

  it('rejects non-JSON media types before executing anything (cross-site simple-request fence)', async () => {
    const describe = vi.fn((request: RpcRequest<{}>) => ok(request, {
      version: '0-test', cwd: '/t', attachedSessions: 0, home: '/h', canOpenPath: true,
    }))
    const handler = toFetchHandler(scriptedApi({ host: { describe } }))
    const body = JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'host.describe', payload: {} })
    // A "simple" browser POST (text/plain — sent with no CORS preflight) is
    // refused at the carrier before the impl runs.
    const plain = await handler.fetch('http://dsh.internal/api/host.describe', { method: 'POST', headers: { 'content-type': 'text/plain' }, body })
    expect(plain.status).toBe(415)
    // A string body with no explicit header defaults to text/plain — same fence.
    const unlabelled = await handler.fetch('http://dsh.internal/api/host.describe', { method: 'POST', body })
    expect(unlabelled.status).toBe(415)
    expect(describe).not.toHaveBeenCalled()
    // Media-type parameters pass: the fence checks the type, not the exact string.
    const charset = await handler.fetch('http://dsh.internal/api/host.describe', { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body })
    expect(charset.status).toBe(200)
    expect(describe).toHaveBeenCalledTimes(1)
  })

  it('rejects when the transport never resolves within timeoutMs', async () => {
    // AbortSignal.timeout is immune to fake timers; a short real timeout keeps this fast.
    const never = new InProcessApiClient({
      fetch: (_i: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new Error('aborted by timeout')) })
      }),
    }, 25)
    await expect(never.host.describe({})).rejects.toThrow()
  })

  it('aborts a unary call through the caller-supplied external signal', async () => {
    // Real-fetch semantics: on abort the rejection is the signal's reason, and the abort
    // works even when the transport ignores the signal entirely (hung impl).
    const gate = new AbortController()
    const hung = new InProcessApiClient({ fetch: () => new Promise<Response>(() => {}) }, 60_000)
    const call = hung.host.describe({}, gate.signal)
    gate.abort(new Error('externally aborted'))
    await expect(call).rejects.toThrow(/externally aborted/)
  })

  it('rejects an already-aborted signal before touching the transport, mapping a string reason to an Error', async () => {
    let touched = false
    const c = new InProcessApiClient({
      fetch: () => {
        touched = true
        return Promise.resolve(new Response('{}'))
      },
    }, 60_000)
    const gate = new AbortController()
    gate.abort('gone before start')
    await expect(c.host.describe({}, gate.signal)).rejects.toThrow('gone before start')
    expect(touched).toBe(false)
  })

  it('maps a non-Error, non-string abort reason to the default AbortError message', async () => {
    const gate = new AbortController()
    const hung = new InProcessApiClient({ fetch: () => new Promise<Response>(() => {}) }, 60_000)
    const call = hung.host.describe({}, gate.signal)
    gate.abort(42)
    await expect(call).rejects.toThrow('This operation was aborted')
  })

  it('passes a signal-less doFetch straight through to the handler', async () => {
    class Probe extends InProcessApiClient {
      direct(url: URL): Promise<Response> {
        return this.doFetch(url)
      }
    }
    const probe = new Probe({ fetch: () => Promise.resolve(new Response('raw')) })
    const response = await probe.direct(new URL('http://dsh.internal/probe'))
    expect(await response.text()).toBe('raw')
  })

  it('throws on an S→C ok value that fails the method value schema (second-level parse)', async () => {
    // Impl echoes rpcId but returns a wrong-shaped value: envelope parse passes, value parse must reject.
    const api = scriptedApi({
      host: { describe: request => Promise.resolve({ rpcId: request.rpcId, result: { ok: true, value: { version: 1 } } }) as never },
    })
    await expect(client(api).host.describe({})).rejects.toThrow()
  })
})

describe('envelope tap', () => {
  it('delivers one microtask batch of full forms per unary call', async () => {
    const api = scriptedApi()
    const tapped = client(api)
    const batches: (readonly RpcMessage[])[] = []
    tapped.subscribeEnvelopes(batch => batches.push(batch))
    await tapped.host.describe({})
    await vi.waitFor(() => { expect(batches.length).toBeGreaterThan(0) })
    const all = batches.flat()
    expect(all.map(m => m.type)).toEqual(['client-request', 'server-response'])
    expect(all[0]?.rpcId).toBe(all[1]?.rpcId)
  })

  it('isolates a throwing listener and keeps serving the call', async () => {
    const api = scriptedApi()
    const tapped = client(api)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const good: string[] = []
      tapped.subscribeEnvelopes(() => { throw new Error('listener bug') })
      tapped.subscribeEnvelopes(batch => good.push(...batch.map(m => m.type)))
      const response = await tapped.host.describe({})
      expect(response.result.ok).toBe(true)
      await vi.waitFor(() => { expect(good).toContain('server-response') })
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('buffers nothing with zero subscribers and unsubscribes cleanly', async () => {
    const api = scriptedApi()
    const tapped = client(api)
    await tapped.host.describe({}) // no subscribers: must not accumulate
    const batches: (readonly RpcMessage[])[] = []
    const unsubscribe = tapped.subscribeEnvelopes(batch => batches.push(batch))
    unsubscribe()
    await tapped.host.describe({})
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(batches).toEqual([])
  })
})
