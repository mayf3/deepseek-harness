import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { installGlobalProxy, proxyForUrl, type ProxyPolicy } from '../src/index.ts'

/**
 * `proxyForUrl` and the installed `EnvHttpProxyAgent` are two matchers over one bypass list. They are
 * fed the same values, but their parsers are independent: a form they judge differently would route a
 * plain `fetch` one way and `web_fetch` the other. These cases pin the forms in the documented
 * vocabulary against the agent's real behavior.
 */
const CASES: readonly { readonly noProxy: string; readonly path: string; readonly bypassed: boolean }[] = [
  { noProxy: '', path: '/plain', bypassed: false },
  { noProxy: 'probe.invalid', path: '/exact', bypassed: true },
  { noProxy: '.probe.invalid', path: '/dot-suffix', bypassed: true },
  { noProxy: '*.probe.invalid', path: '/star-suffix', bypassed: true },
  { noProxy: 'other.invalid', path: '/miss', bypassed: false },
  { noProxy: '*', path: '/all', bypassed: true },
  { noProxy: 'probe.invalid:80', path: '/with-default-port', bypassed: true },
  { noProxy: 'probe.invalid:8443', path: '/wrong-port', bypassed: false },
  { noProxy: 'a.invalid, probe.invalid', path: '/comma-list', bypassed: true },
]

let seen: string[] = []
let proxy: Server
let proxyUrl: string

beforeAll(async () => {
  proxy = createServer((request, response) => {
    seen.push(request.url ?? '')
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('VIA-PROXY')
  })
  const address = await new Promise<AddressInfo>((resolve) => {
    proxy.listen(0, '127.0.0.1', () => { resolve(proxy.address() as AddressInfo) })
  })
  proxyUrl = `http://127.0.0.1:${String(address.port)}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => { proxy.close(() => { resolve() }) })
})

function policy(noProxy: string): ProxyPolicy {
  return { httpProxy: proxyUrl, httpsProxy: proxyUrl, noProxy, source: 'env' }
}

describe('bypass matcher parity', () => {
  it.each(CASES)('agrees on $noProxy for $path', async ({ noProxy, path, bypassed }) => {
    seen = []
    const url = new URL(`http://probe.invalid${path}`)
    const dispose = await installGlobalProxy(policy(noProxy))
    try {
      // A bypassed target has no route here, so the fetch fails; a proxied one reaches the recorder.
      await fetch(url).then(response => response.text()).catch(() => undefined)
      const agentProxied = seen.length > 0
      expect({ ours: proxyForUrl(policy(noProxy), url) !== undefined, agent: agentProxied })
        .toEqual({ ours: !bypassed, agent: !bypassed })
    } finally {
      await dispose()
    }
  })
})
