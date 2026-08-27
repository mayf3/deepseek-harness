import { createServer, type Server } from 'node:http'
import { spawn } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  PROXY_ENV_NAMES,
  installGlobalProxy,
  resolveProxyPolicy,
} from '@deepseek-ai/dsh-http-proxy'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { scrubbedParentEnv } from '../src/index.ts'

/**
 * Whether this runtime honors `NODE_USE_ENV_PROXY`, which is how a child Node receives the policy.
 * Added in Node 24.0 and backported to 22.21; the engines range admits 22.19 and 22.20, where a
 * child stays direct.
 */
function supportsEnvProxy(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
  return major >= 24 || (major === 22 && minor >= 21)
}

let seen: string[] = []
let proxy: Server
let proxyUrl: string
let saved: Record<string, string | undefined> = {}

beforeAll(async () => {
  proxy = createServer((request, response) => {
    seen.push(request.url ?? '')
    response.writeHead(200)
    response.end('VIA-PROXY')
  })
  // Node's own proxy support may tunnel rather than send an absolute-form request; record either.
  proxy.on('connect', (request, socket) => {
    seen.push(request.url ?? '')
    socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    socket.end()
  })
  const address = await new Promise<AddressInfo>((resolve) => {
    proxy.listen(0, '127.0.0.1', () => { resolve(proxy.address() as AddressInfo) })
  })
  proxyUrl = `http://127.0.0.1:${String(address.port)}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => { proxy.close(() => { resolve() }) })
})

beforeEach(() => {
  seen = []
  saved = Object.fromEntries(PROXY_ENV_NAMES.map(name => [name, process.env[name]]))
  for (const name of PROXY_ENV_NAMES) Reflect.deleteProperty(process.env, name)
})

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = value
  }
})

/** Run a child Node that fetches, using exactly the environment every harness spawner builds. */
function childFetch(target: string, env: Record<string, string>): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['-e', `fetch(${JSON.stringify(target)}).then(r=>r.text()).then(t=>console.log(t)).catch(e=>console.log('ERR'+String(e.cause?.code)))`],
      { env, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
    child.on('close', () => { resolve(out.trim()) })
  })
}

describe('child process egress', () => {
  it('a child Node honors the proxy the user exported', async () => {
    // The user's own export is what a child inherits, so the scenario starts from one.
    process.env.HTTP_PROXY = proxyUrl
    const { policy } = resolveProxyPolicy(
      createLaunchEnvironmentSnapshot([{ source: 'process', values: { HTTP_PROXY: proxyUrl } }]),
    )
    const dispose = await installGlobalProxy(policy)
    let childEnv: Record<string, string> = {}
    try {
      childEnv = scrubbedParentEnv()
      await childFetch('http://child-probe.invalid/x', childEnv)
    } finally {
      await dispose()
    }
    expect(childEnv.NODE_USE_ENV_PROXY).toBe('1')
    expect(childEnv.HTTP_PROXY).toBe(proxyUrl)
    // The flag is what a child Node acts on; an older runtime ignores it and stays direct, which is
    // the documented seam rather than a defect.
    if (supportsEnvProxy()) expect(seen.join('|')).toContain('child-probe.invalid')
    else expect(seen).toEqual([])
  })

  it('does not invent a proxy name the user never exported', async () => {
    process.env.HTTP_PROXY = proxyUrl
    const { policy } = resolveProxyPolicy(
      createLaunchEnvironmentSnapshot([{ source: 'process', values: { HTTP_PROXY: proxyUrl } }]),
    )
    const dispose = await installGlobalProxy(policy)
    try {
      // This process resolved an HTTPS proxy by falling back to the HTTP one; a child must not see
      // a name the user never set, because `curl` performs no such fallback of its own.
      expect(process.env.HTTPS_PROXY).toBe(proxyUrl)
      expect(scrubbedParentEnv().HTTPS_PROXY).toBeUndefined()
    } finally {
      await dispose()
    }
  })

  it('adds nothing when no proxy is active', () => {
    expect(scrubbedParentEnv().NODE_USE_ENV_PROXY).toBeUndefined()
  })
})
