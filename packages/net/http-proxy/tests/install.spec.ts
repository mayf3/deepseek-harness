import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest'
import { getGlobalDispatcher } from 'undici'
import http from 'node:http'
import https from 'node:https'
import {
  childProxyEnv,
  createDispatcher,
  createNodeHttpAgent,
  currentProxyPolicy,
  installGlobalProxy,
  proxyUrlFor,
} from '../src/install.ts'
import { DIRECT_POLICY, PROXY_ENV_NAMES, type ProxyPolicy } from '../src/policy.ts'

/** Absolute-form request targets the fake proxy received; a populated entry proves a request was tunnelled. */
let proxied: string[] = []
let proxy: Server
let origin: Server
let proxyUrl: string
let originUrl: string

/**
 * The target for every assertion about a tunnelled hop. It is deliberately not loopback: no policy
 * routes this machine through a proxy, so a loopback target could only ever prove a direct hop. The
 * host never resolves — the client connects to the proxy, which answers the absolute-form request.
 */
const proxyTarget = 'http://origin.test/probe'

function listen(server: Server): Promise<AddressInfo> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => { resolve(server.address() as AddressInfo) })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => { server.close(() => { resolve() }) })
}

beforeAll(async () => {
  proxy = createServer((request, response) => {
    proxied.push(`${request.method} ${request.url}`)
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('VIA-PROXY')
  })
  proxy.on('connect', (request, socket) => {
    proxied.push(`CONNECT ${request.url ?? ''}`)
    socket.end()
  })
  origin = createServer((_request, response) => { response.end('DIRECT') })
  const [proxyAddress, originAddress] = await Promise.all([listen(proxy), listen(origin)])
  proxyUrl = `http://127.0.0.1:${String(proxyAddress.port)}`
  originUrl = `http://127.0.0.1:${String(originAddress.port)}/probe`
})

afterAll(async () => {
  await Promise.all([close(proxy), close(origin)])
})

afterEach(() => {
  proxied = []
})

/** A second proxy URL, never dialed: it only has to differ from {@link proxyUrl} in an assertion. */
const nestedUrl = 'http://127.0.0.1:9'

/** A policy proxying everything, since the resolved default always bypasses the loopback these tests use. */
function proxyAll(noProxy = ''): ProxyPolicy {
  return { httpProxy: proxyUrl, httpsProxy: proxyUrl, noProxy, source: 'env' }
}

describe('installGlobalProxy', () => {
  it('routes the built-in global fetch through the proxy', async () => {
    const dispose = await installGlobalProxy(proxyAll())
    try {
      await expect((await fetch(proxyTarget)).text()).resolves.toBe('VIA-PROXY')
      expect(proxied).toEqual([`GET ${proxyTarget}`])
    } finally {
      await dispose()
    }
  })

  it('connects directly when the bypass list covers the target', async () => {
    const dispose = await installGlobalProxy(proxyAll('127.0.0.1'))
    try {
      await expect((await fetch(originUrl)).text()).resolves.toBe('DIRECT')
      expect(proxied).toEqual([])
    } finally {
      await dispose()
    }
  })

  it('publishes the policy through the proxy environment in both casings', async () => {
    const dispose = await installGlobalProxy(proxyAll('example.com'))
    try {
      expect(process.env.http_proxy).toBe(proxyUrl)
      expect(process.env.HTTP_PROXY).toBe(proxyUrl)
      expect(process.env.no_proxy).toBe('example.com')
      expect(process.env.NO_PROXY).toBe('example.com')
    } finally {
      await dispose()
    }
  })

  it('removes an environment name the policy leaves unset', async () => {
    process.env.HTTPS_PROXY = 'http://stale.example'
    const dispose = await installGlobalProxy({ httpProxy: proxyUrl, noProxy: '', source: 'env' })
    try {
      expect(process.env.HTTPS_PROXY).toBeUndefined()
    } finally {
      await dispose()
      expect(process.env.HTTPS_PROXY).toBe('http://stale.example')
      delete process.env.HTTPS_PROXY
    }
  })

  it('restores the dispatcher, the policy, and the environment on disposal', async () => {
    const before = getGlobalDispatcher()
    const beforeEnv = process.env.HTTP_PROXY
    const beforePolicy = currentProxyPolicy()
    const dispose = await installGlobalProxy(proxyAll())
    expect(getGlobalDispatcher()).not.toBe(before)
    expect(currentProxyPolicy()).not.toBe(beforePolicy)
    await dispose()
    expect(getGlobalDispatcher()).toBe(before)
    expect(currentProxyPolicy()).toBe(beforePolicy)
    expect(process.env.HTTP_PROXY).toBe(beforeEnv)
    await expect((await fetch(originUrl)).text()).resolves.toBe('DIRECT')
  })

  it('installs no dispatcher and touches no environment for a direct policy', async () => {
    const before = getGlobalDispatcher()
    process.env.HTTP_PROXY = 'http://untouched.example'
    const dispose = await installGlobalProxy(DIRECT_POLICY)
    try {
      expect(getGlobalDispatcher()).toBe(before)
      expect(process.env.HTTP_PROXY).toBe('http://untouched.example')
      expect(currentProxyPolicy()).toBe(DIRECT_POLICY)
    } finally {
      await dispose()
      delete process.env.HTTP_PROXY
    }
    expect(currentProxyPolicy()).toBeUndefined()
  })
  it('keeps a scheme direct when the policy refused the proxy the user named for it', async () => {
    // What `HTTPS_PROXY=socks5://…` plus `HTTP_PROXY=http://p` resolves to: http proxied, https
    // direct. undici's own EnvHttpProxyAgent cannot express this — with no HTTPS proxy present it
    // reuses the HTTP one, tunnelling the scheme the diagnostic told the user stayed direct.
    const dispose = await installGlobalProxy({ httpProxy: proxyUrl, noProxy: '', source: 'env' })
    try {
      // The direct path here fails on a DNS miss whose latency is the machine's resolver to decide;
      // the deadline bounds it. Either rejection proves the same thing — no CONNECT reached the
      // proxy — and a proxied hop would have answered in milliseconds instead.
      await expect(fetch('https://refused-scheme.invalid/', { signal: AbortSignal.timeout(1500) })).rejects.toThrow()
      expect(proxied).toEqual([])
      // The same policy still tunnels http, so the empty expectation above is not vacuous.
      await expect((await fetch(proxyTarget)).text()).resolves.toBe('VIA-PROXY')
      expect(proxied).toEqual([`GET ${proxyTarget}`])
    } finally {
      await dispose()
    }
  })
})

describe('createDispatcher', () => {
  it('tunnels through the proxy when the policy covers the URL', async () => {
    const dispose = await installGlobalProxy(proxyAll())
    const dispatcher = await createDispatcher(new URL(proxyTarget))
    try {
      const undici = await import('undici')
      const response = await undici.fetch(proxyTarget, { dispatcher })
      await expect(response.text()).resolves.toBe('VIA-PROXY')
    } finally {
      await dispatcher.close()
      await dispose()
    }
  })

  it('connects directly when the policy bypasses the URL', async () => {
    const dispose = await installGlobalProxy(proxyAll('127.0.0.1'))
    const dispatcher = await createDispatcher(new URL(originUrl))
    try {
      const undici = await import('undici')
      const response = await undici.fetch(originUrl, { dispatcher })
      await expect(response.text()).resolves.toBe('DIRECT')
      expect(proxied).toEqual([])
    } finally {
      await dispatcher.close()
      await dispose()
    }
  })

  it('connects directly when no policy is installed', async () => {
    const dispatcher = await createDispatcher(new URL(originUrl))
    try {
      const undici = await import('undici')
      await expect((await undici.fetch(originUrl, { dispatcher })).text()).resolves.toBe('DIRECT')
    } finally {
      await dispatcher.close()
    }
  })

  it('routes by the policy it was handed, not one replaced after the caller branched', async () => {
    const dispose = await installGlobalProxy(proxyAll())
    const branched = currentProxyPolicy()
    expect(branched).toBeDefined()
    // The caller has already decided this hop is proxied and skipped its address checks. Unmounting
    // the plugin here is what a hot reload does mid-request; reading the active policy again would
    // hand back a direct agent and connect to an origin nothing validated.
    await dispose()
    const dispatcher = await createDispatcher(new URL(proxyTarget), {}, branched)
    try {
      const undici = await import('undici')
      await expect((await undici.fetch(proxyTarget, { dispatcher })).text()).resolves.toBe('VIA-PROXY')
    } finally {
      await dispatcher.close()
    }
  })
})

describe('childProxyEnv', () => {
  it('is empty when no policy is installed', () => {
    expect(childProxyEnv()).toEqual({})
  })

  it('is empty under a direct policy, so a child sees no flag it cannot use', async () => {
    const dispose = await installGlobalProxy(DIRECT_POLICY)
    try {
      expect(childProxyEnv()).toEqual({})
    } finally {
      await dispose()
    }
  })

  it('hands a child the values the user exported, not this process\'s normalization', async () => {
    // Start from a known environment: a CI runner or developer machine may export its own proxy,
    // which would otherwise appear as the "user's" value and decide this assertion.
    const saved = Object.fromEntries(PROXY_ENV_NAMES.map(name => [name, process.env[name]]))
    for (const name of PROXY_ENV_NAMES) Reflect.deleteProperty(process.env, name)
    // A user who set only HTTP_PROXY, plus a SOCKS proxy this package refuses but `curl` uses.
    process.env.HTTP_PROXY = proxyUrl
    process.env.https_proxy = 'socks5://127.0.0.1:1080'
    const dispose = await installGlobalProxy(proxyAll('example.com'))
    try {
      const child = childProxyEnv()
      // The published policy derived an HTTPS proxy for this process; the child must not see it.
      // Asserted over both casings rather than one: Windows folds the pair into a single variable,
      // so which spelling carries the value is the platform's to decide — that it is the user's
      // value and never the derived one is not.
      const https = [child.https_proxy, child.HTTPS_PROXY]
      expect(https).toContain('socks5://127.0.0.1:1080')
      expect(https).not.toContain(proxyUrl)
      expect(child.HTTP_PROXY).toBe(proxyUrl)
      // The bypass list is the resolved one even though the user set none: it only adds entries,
      // and without it the child sends its own loopback traffic to a proxy that cannot route it.
      expect(child.no_proxy).toBe('example.com')
      expect(child.NO_PROXY).toBe('example.com')
      expect(child.NODE_USE_ENV_PROXY).toBe('1')
    } finally {
      await dispose()
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) Reflect.deleteProperty(process.env, name)
        else process.env[name] = value
      }
    }
  })
  it('fills a scheme the user named in neither casing, so a child Node is not left direct', async () => {
    const saved = Object.fromEntries(PROXY_ENV_NAMES.map(name => [name, process.env[name]]))
    for (const name of PROXY_ENV_NAMES) Reflect.deleteProperty(process.env, name)
    // The user exported only ALL_PROXY. `NODE_USE_ENV_PROXY` never reads that name, so a child
    // Node would connect directly while this process proxies — the seam this fill closes.
    process.env.ALL_PROXY = proxyUrl
    const dispose = await installGlobalProxy(proxyAll('example.com'))
    try {
      const child = childProxyEnv()
      expect(child.HTTP_PROXY).toBe(proxyUrl)
      expect(child.http_proxy).toBe(proxyUrl)
      expect(child.HTTPS_PROXY).toBe(proxyUrl)
      expect(child.https_proxy).toBe(proxyUrl)
    } finally {
      await dispose()
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) Reflect.deleteProperty(process.env, name)
        else process.env[name] = value
      }
    }
  })

  it('propagates a proxy that only a composition declared', async () => {
    const saved = Object.fromEntries(PROXY_ENV_NAMES.map(name => [name, process.env[name]]))
    for (const name of PROXY_ENV_NAMES) Reflect.deleteProperty(process.env, name)
    const dispose = await installGlobalProxy({ ...proxyAll('example.com'), source: 'config' })
    try {
      // Nothing was exported, so every name carries the configured policy rather than being removed.
      expect(childProxyEnv()).toEqual({
        NODE_USE_ENV_PROXY: '1',
        http_proxy: proxyUrl,
        HTTP_PROXY: proxyUrl,
        https_proxy: proxyUrl,
        HTTPS_PROXY: proxyUrl,
        no_proxy: 'example.com',
        NO_PROXY: 'example.com',
      })
    } finally {
      await dispose()
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) Reflect.deleteProperty(process.env, name)
        else process.env[name] = value
      }
    }
  })

  it('keeps the outermost install\'s record of what the user exported across a nested one', async () => {
    const saved = Object.fromEntries(PROXY_ENV_NAMES.map(name => [name, process.env[name]]))
    for (const name of PROXY_ENV_NAMES) Reflect.deleteProperty(process.env, name)
    // The user exported one name, in one casing.
    process.env.HTTP_PROXY = proxyUrl
    const nested: ProxyPolicy = { httpProxy: nestedUrl, httpsProxy: nestedUrl, noProxy: '', source: 'env' }
    // The launcher installs first; mounting the plugin installs a second policy over it.
    const disposeOuter = await installGlobalProxy(proxyAll('example.com'))
    try {
      const disposeInner = await installGlobalProxy(nested)
      try {
        const child = childProxyEnv()
        // The user named no HTTPS proxy, so this scheme carries whichever policy is active. Reading
        // the outer install's published environment as the user's would pin it to the outer proxy
        // instead — the one discriminator that does not depend on how a platform cases names.
        expect(child.https_proxy).toBe(nestedUrl)
        expect(child.HTTPS_PROXY).toBe(nestedUrl)
      } finally {
        await disposeInner()
      }
      // Unmounting the inner install must leave the outer one still able to describe that
      // environment; clearing the record instead makes this an empty object, so every later child
      // inherits the normalized values from `process.env` untouched.
      expect(childProxyEnv().HTTP_PROXY).toBe(proxyUrl)
      expect(childProxyEnv().https_proxy).toBe(proxyUrl)
    } finally {
      await disposeOuter()
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) Reflect.deleteProperty(process.env, name)
        else process.env[name] = value
      }
    }
  })
})

describe('installGlobalProxy over an existing installation', () => {
  it('stops proxying when a direct policy is installed over a proxied one', async () => {
    const outer = await installGlobalProxy(proxyAll())
    try {
      await expect((await fetch(proxyTarget)).text()).resolves.toBe('VIA-PROXY')
      const off = await installGlobalProxy(DIRECT_POLICY)
      try {
        // `mode: 'off'` must actually stop proxying, not merely report a direct policy while the
        // launcher's agent keeps tunnelling. A direct hop needs a host that answers, so this one
        // reaches the real origin rather than the name only the proxy can resolve.
        await expect((await fetch(originUrl)).text()).resolves.toBe('DIRECT')
        expect(currentProxyPolicy()).toBe(DIRECT_POLICY)
      } finally {
        await off()
      }
      // Disposing the direct policy restores the proxy the launcher installed.
      await expect((await fetch(proxyTarget)).text()).resolves.toBe('VIA-PROXY')
    } finally {
      await outer()
    }
  })
})

describe('applyPolicyEnv restoration', () => {
  it('restores every name from one snapshot taken before any write', async () => {
    process.env.http_proxy = 'http://before.example'
    process.env.HTTP_PROXY = 'http://before.example'
    const dispose = await installGlobalProxy(proxyAll())
    expect(process.env.HTTP_PROXY).toBe(proxyUrl)
    await dispose()
    // Reading the uppercase spelling after writing the lowercase one must not restore the value
    // just written — the failure Windows's case-folded environment would produce.
    expect(process.env.http_proxy).toBe('http://before.example')
    expect(process.env.HTTP_PROXY).toBe('http://before.example')
    delete process.env.http_proxy
    delete process.env.HTTP_PROXY
  })
})

describe('createNodeHttpAgent', () => {
  /**
   * Whether this runtime's `http.Agent` honors `proxyEnv`, the option this agent routes through.
   * Added in Node 24.5 and backported to 22.21; the engines range admits 22.19, 22.20, and
   * 24.0–24.4, where the option is ignored and the request stays direct.
   */
  function supportsAgentProxyEnv(): boolean {
    const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
    return (major === 24 && minor >= 5) || major > 24 || (major === 22 && minor >= 21)
  }

  /** Drive a real `node:http` request, which the global dispatcher never reaches. */
  function get(target: string, agent: http.Agent): Promise<string> {
    return new Promise((resolve) => {
      http.get(target, { agent }, (response) => {
        let body = ''
        response.on('data', (chunk: Buffer) => { body += chunk.toString() })
        response.on('end', () => { resolve(body) })
      }).on('error', (error: NodeJS.ErrnoException) => { resolve(`ERR ${error.code ?? ''}`) })
    })
  }

  it('routes a node:http request through the proxy', async () => {
    const dispose = await installGlobalProxy(proxyAll())
    const agent = await createNodeHttpAgent('http:')
    try {
      // An older runtime ignores the unknown `proxyEnv` option and connects directly — the seam
      // this agent's documentation names, asserted rather than left to fail the suite there.
      await expect(get(originUrl, agent)).resolves.toBe(supportsAgentProxyEnv() ? 'VIA-PROXY' : 'DIRECT')
    } finally {
      agent.destroy()
      await dispose()
    }
  })

  it('connects directly when no policy is installed', async () => {
    const agent = await createNodeHttpAgent('http:', { keepAlive: false })
    try {
      await expect(get(originUrl, agent)).resolves.toBe('DIRECT')
    } finally {
      agent.destroy()
    }
  })

  it('selects the TLS agent for an https target', async () => {
    const agent = await createNodeHttpAgent('https:')
    try {
      expect(agent).toBeInstanceOf(https.Agent)
    } finally {
      agent.destroy()
    }
  })
})

describe('proxyUrlFor', () => {
  it('names the proxy an SDK with its own transport must use', async () => {
    const dispose = await installGlobalProxy(proxyAll())
    try {
      expect(proxyUrlFor(new URL('https://api.example.com/v1'))).toBe(proxyUrl)
    } finally {
      await dispose()
    }
  })

  it('names none for a bypassed host, and none at all without a policy', async () => {
    const dispose = await installGlobalProxy(proxyAll('api.example.com'))
    try {
      expect(proxyUrlFor(new URL('https://api.example.com/v1'))).toBeUndefined()
    } finally {
      await dispose()
    }
    expect(proxyUrlFor(new URL('https://api.example.com/v1'))).toBeUndefined()
  })
})
