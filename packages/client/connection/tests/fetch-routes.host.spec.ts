import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserAuth } from '../src/browser-auth.ts'
import { HostConnectionService } from '../src/rpc-host.ts'

async function mounted(): Promise<{
  readonly connection: HostConnectionService
  readonly dispose: () => Promise<void>
}> {
  const ctx = new Context()
  const fiber = ctx.plugin((pluginCtx) => {
    new HostConnectionService(pluginCtx, [], {} as BrowserAuth)
  })
  await fiber.await()
  return {
    connection: ctx.get('connection') as HostConnectionService,
    dispose: () => fiber.dispose(),
  }
}

describe('Connection exact Fetch routes', () => {
  it('dispatches owned methods before the transitional fallback', async () => {
    const { connection, dispose: disposeFiber } = await mounted()
    const route = vi.fn(async (request: Request) =>
      Response.json({ query: new URL(request.url).searchParams.get('sessionId') }))
    const fallback = vi.fn(async () => new Response('fallback', { status: 418 }))
    const dispose = connection.fetch.register({
      path: '/api/session.export',
      methods: ['GET', 'HEAD'],
      fetch: route,
    })
    const shared = connection.createSharedFetchHandler('/api', { fetch: fallback })

    const response = await shared.fetch(new Request(
      'http://host/api/session.export?sessionId=session-1',
    ))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ query: 'session-1' })
    expect(route).toHaveBeenCalledOnce()
    expect(fallback).not.toHaveBeenCalled()

    const post = await shared.fetch(new Request('http://host/api/session.export', { method: 'POST' }))
    expect(post.status).toBe(418)
    expect(fallback).toHaveBeenCalledOnce()

    await dispose()
    const withdrawn = await shared.fetch(new Request('http://host/api/session.export'))
    expect(withdrawn.status).toBe(418)
    expect(fallback).toHaveBeenCalledTimes(2)
    await disposeFiber()
  })

  it('rejects invalid and duplicate registrations', async () => {
    const { connection, dispose: disposeFiber } = await mounted()
    const fetch = async (): Promise<Response> => new Response()

    expect(() => connection.fetch.register({ path: '/outside', methods: ['GET'], fetch }))
      .toThrow('invalid exact Fetch route')
    expect(() => connection.fetch.register({ path: '/api/session.export', methods: [], fetch }))
      .toThrow('declares no methods')
    expect(() => connection.fetch.register({
      path: '/api/session.export', methods: ['GET', 'GET'], fetch,
    })).toThrow('repeats a method')
    expect(() => connection.fetch.register({
      path: '/api/session.export', methods: ['POST' as 'GET'], fetch,
    })).toThrow('unsupported method')

    const dispose = connection.fetch.register({
      path: '/api/session.export', methods: ['GET'], fetch,
    })
    expect(() => connection.fetch.register({
      path: '/api/session.export', methods: ['HEAD'], fetch,
    })).toThrow('already registered')
    await dispose()
    expect(() => connection.fetch.register({
      path: '/api/session.export', methods: ['HEAD'], fetch,
    })).not.toThrow()
    await disposeFiber()
  })
})
