import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { installGlobalProxy, type ProxyPolicy } from '@deepseek-ai/dsh-http-proxy'

let seen: string[] = []
let proxy: Server
let proxyUrl: string

beforeAll(async () => {
  proxy = createServer((request, response) => {
    seen.push(`REQ ${request.url ?? ''}`)
    response.writeHead(502); response.end('fake-proxy')
  })
  proxy.on('connect', (request, socket) => {
    seen.push(`CONNECT ${request.url ?? ''}`)
    socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); socket.end()
  })
  const a = await new Promise<AddressInfo>((r) => { proxy.listen(0, '127.0.0.1', () => { r(proxy.address() as AddressInfo) }) })
  proxyUrl = `http://127.0.0.1:${String(a.port)}`
})
afterAll(async () => { await new Promise<void>((r) => { proxy.close(() => { r() }) }) })

function policy(): ProxyPolicy {
  return { httpProxy: proxyUrl, httpsProxy: proxyUrl, noProxy: '', source: 'env' }
}
async function observe(run: () => Promise<unknown>): Promise<string[]> {
  seen = []
  const dispose = await installGlobalProxy(policy())
  try { await run().catch(() => undefined) } finally { await dispose() }
  return seen
}
import { Context } from '@deepseek-ai/cordis'
import E2bRuntime from '../src/index.ts'

describe('e2b egress', () => {
  it('reaches the control plane through the proxy', async () => {
    const observed = await observe(async () => {
      const ctx = new Context()
      const fiber = await ctx.plugin(E2bRuntime, { apiKey: `e2b_${'0'.repeat(40)}`, cwd: '/home/user', timeoutMs: 5_000 })
      await ctx.e2b.getSandbox().catch(() => undefined)
      await fiber.dispose()
    })
    expect(observed.join('|')).toContain('api.e2b.app:443')
  })
})

describe('e2b control-plane URL', () => {
  it('follows the SDK precedence so the proxy decision matches the real target', async () => {
    const { e2bApiUrl } = await import('../src/index.ts')
    expect(e2bApiUrl({})).toBe('https://api.e2b.app')
    expect(e2bApiUrl({ E2B_DOMAIN: 'e2b.dev' })).toBe('https://api.e2b.dev')
    expect(e2bApiUrl({ E2B_DEBUG: 'TRUE' })).toBe('http://localhost:3000')
    expect(e2bApiUrl({ E2B_API_URL: 'https://api.internal.example', E2B_DEBUG: 'true' }))
      .toBe('https://api.internal.example')
  })

  it('keeps the loopback debug plane direct instead of sending its API key to a proxy', async () => {
    const { e2bApiUrl } = await import('../src/index.ts')
    const { proxyForUrl, resolveProxyPolicy } = await import('@deepseek-ai/dsh-http-proxy')
    const { createLaunchEnvironmentSnapshot } = await import('@deepseek-ai/dsh-launch-environment')
    // A resolved policy — the shape a real launch installs — always bypasses loopback.
    const { policy: resolved } = resolveProxyPolicy(
      createLaunchEnvironmentSnapshot([{ source: 'process', values: { HTTP_PROXY: proxyUrl } }]),
    )
    expect(proxyForUrl(resolved, new URL(e2bApiUrl({ E2B_DEBUG: 'true' })))).toBeUndefined()
    expect(proxyForUrl(resolved, new URL(e2bApiUrl({})))).toBe(proxyUrl)
  })
})
