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
import { ExaSearchProvider } from '../src/provider.ts'
describe('exa egress', () => {
  it('goes through the proxy', async () => {
    const p = new ExaSearchProvider({ apiKey: 'probe', baseURL: 'http://exa-probe.invalid', searchType: 'auto', highlightsPerResult: 1 })
    expect(await observe(() => p.search({ query: 'probe' }))).toEqual(['REQ http://exa-probe.invalid/search'])
  })
})
