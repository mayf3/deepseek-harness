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
import { spawn } from 'node:child_process'
import { scrubbedParentEnv } from '../src/index.ts'

/** Run a child Node that fetches, using exactly the environment every harness spawner builds. */
function childFetch(target: string, env: Record<string, string>): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', `fetch(${JSON.stringify(target)}).then(r=>r.text()).then(t=>console.log(t)).catch(e=>console.log('ERR'+String(e.cause?.code)))`],
      { env, stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', (c: Buffer) => { out += c.toString() })
    child.on('close', () => { resolve(out.trim()) })
  })
}


/**
 * Whether this runtime honors `NODE_USE_ENV_PROXY`, which is how a separate Node execution context
 * receives the policy. Added in Node 24.0 and backported to 22.21; the engines range admits 22.19
 * and 22.20, where such a context stays direct.
 */
function supportsEnvProxy(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
  return major >= 24 || (major === 22 && minor >= 21)
}

describe('child process egress', () => {
  it('a child Node honors the parent policy through scrubbedParentEnv', async () => {
    let childEnv: Record<string, string> = {}
    const observed = await observe(async () => {
      childEnv = scrubbedParentEnv()
      await childFetch('http://child-probe.invalid/x', childEnv)
    })
    expect(childEnv.NODE_USE_ENV_PROXY).toBe('1')
    // The flag is what a child Node acts on; an older runtime ignores it and stays direct, which is
    // the documented seam rather than a defect.
    if (supportsEnvProxy()) expect(observed.join('|')).toContain('child-probe.invalid')
    else expect(observed).toEqual([])
  })
})
