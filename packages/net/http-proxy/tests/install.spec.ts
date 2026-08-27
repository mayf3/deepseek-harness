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
import { DIRECT_POLICY, type ProxyPolicy } from '../src/policy.ts'

/** Absolute-form request targets the fake proxy received; a populated entry proves a request was tunnelled. */
let proxied: string[] = []
let proxy: Server
let origin: Server
let proxyUrl: string
let originUrl: string

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

/** A policy proxying everything, since the resolved default always bypasses the loopback these tests use. */
function proxyAll(noProxy = ''): ProxyPolicy {
  return { httpProxy: proxyUrl, httpsProxy: proxyUrl, noProxy, source: 'env' }
}

describe('installGlobalProxy', () => {
  it('routes the built-in global fetch through the proxy', async () => {
    const dispose = await installGlobalProxy(proxyAll())
    try {
      await expect((await fetch(originUrl)).text()).resolves.toBe('VIA-PROXY')
      expect(proxied).toEqual([`GET ${originUrl}`])
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
})

describe('createDispatcher', () => {
  it('tunnels through the proxy when the policy covers the URL', async () => {
    const dispose = await installGlobalProxy(proxyAll())
    const dispatcher = await createDispatcher(new URL(originUrl))
    try {
      const undici = await import('undici')
      const response = await undici.fetch(originUrl, { dispatcher })
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
    // A user who set only HTTP_PROXY, plus a SOCKS proxy this package refuses but `curl` uses.
    process.env.HTTP_PROXY = proxyUrl
    process.env.https_proxy = 'socks5://127.0.0.1:1080'
    const dispose = await installGlobalProxy(proxyAll('example.com'))
    try {
      const child = childProxyEnv()
      // The published policy invented an HTTPS proxy for this process; the child must not see it.
      expect(child.https_proxy).toBe('socks5://127.0.0.1:1080')
      expect(child.HTTPS_PROXY).toBeUndefined()
      expect(child.HTTP_PROXY).toBe(proxyUrl)
      expect(child.no_proxy).toBeUndefined()
      expect(child.NODE_USE_ENV_PROXY).toBe('1')
    } finally {
      await dispose()
      delete process.env.HTTP_PROXY
      delete process.env.https_proxy
    }
  })
})

describe('installGlobalProxy over an existing installation', () => {
  it('stops proxying when a direct policy is installed over a proxied one', async () => {
    const outer = await installGlobalProxy(proxyAll())
    try {
      await expect((await fetch(originUrl)).text()).resolves.toBe('VIA-PROXY')
      const off = await installGlobalProxy(DIRECT_POLICY)
      try {
        // `mode: 'off'` must actually stop proxying, not merely report a direct policy while the
        // launcher's agent keeps tunnelling.
        await expect((await fetch(originUrl)).text()).resolves.toBe('DIRECT')
        expect(currentProxyPolicy()).toBe(DIRECT_POLICY)
      } finally {
        await off()
      }
      // Disposing the direct policy restores the proxy the launcher installed.
      await expect((await fetch(originUrl)).text()).resolves.toBe('VIA-PROXY')
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
      await expect(get(originUrl, agent)).resolves.toBe('VIA-PROXY')
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
