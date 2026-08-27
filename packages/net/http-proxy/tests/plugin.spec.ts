import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { getGlobalDispatcher } from 'undici'
import * as HttpProxy from '../src/index.ts'
import * as HttpProxyInvariant from '../src/invariant.ts'

const PROXY = 'http://127.0.0.1:7897'

/**
 * Every proxy name in both casings. The suite clears all of them so a developer's own exported proxy
 * cannot decide the outcome — the lowercase names matter most, since resolution reads those first.
 */
const PROXY_ENV_NAMES = [
  'http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY',
  'no_proxy', 'NO_PROXY', 'all_proxy', 'ALL_PROXY',
] as const

let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = Object.fromEntries(PROXY_ENV_NAMES.map(name => [name, process.env[name]]))
  for (const name of PROXY_ENV_NAMES) Reflect.deleteProperty(process.env, name)
})

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = value
  }
})

/** The launcher normally provides a snapshot; without one the plugin reads the process environment. */
function withEnv(values: Record<string, string>): void {
  for (const [name, value] of Object.entries(values)) process.env[name] = value
}

describe('http-proxy plugin', () => {
  it('installs the configured policy and restores the dispatcher on disposal', async () => {
    const before = getGlobalDispatcher()
    const ctx = new Context()
    const fiber = await ctx.plugin(HttpProxy, { httpProxy: PROXY })

    expect(HttpProxy.currentProxyPolicy()?.httpProxy).toBe(PROXY)
    expect(getGlobalDispatcher()).not.toBe(before)

    await fiber.dispose()
    expect(HttpProxy.currentProxyPolicy()).toBeUndefined()
    expect(getGlobalDispatcher()).toBe(before)
  })

  it('lets a real environment variable outrank the configured proxy', async () => {
    withEnv({ HTTP_PROXY: PROXY })
    const ctx = new Context()
    const fiber = await ctx.plugin(HttpProxy, { httpProxy: 'http://127.0.0.1:9' })
    try {
      expect(HttpProxy.currentProxyPolicy()?.httpProxy).toBe(PROXY)
    } finally {
      await fiber.dispose()
    }
  })

  it('installs nothing under mode off, even with a proxy in the environment', async () => {
    withEnv({ HTTP_PROXY: PROXY })
    const before = getGlobalDispatcher()
    const ctx = new Context()
    const fiber = await ctx.plugin(HttpProxy, { mode: 'off' })
    try {
      expect(HttpProxy.currentProxyPolicy()?.source).toBe('none')
      expect(getGlobalDispatcher()).toBe(before)
    } finally {
      await fiber.dispose()
    }
  })

  it('reports an unusable environment value and connects directly instead of failing the load', async () => {
    withEnv({ HTTP_PROXY: 'socks5://127.0.0.1:1080' })
    const before = getGlobalDispatcher()
    const ctx = new Context()
    const fiber = await ctx.plugin(HttpProxy, {})
    try {
      expect(HttpProxy.currentProxyPolicy()?.source).toBe('none')
      expect(getGlobalDispatcher()).toBe(before)
    } finally {
      await fiber.dispose()
    }
  })

  it('fails the load when the composition itself declares an unusable proxy', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(HttpProxy, { httpsProxy: 'socks5://127.0.0.1:1080' }))
      .rejects.toThrow(/SOCKS proxy/)
  })
})

describe('http-proxy invariant companion', () => {
  it('reserves the package name against duplicate registration', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(HttpProxyInvariant)

    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-http-proxy', () => {})
    }).toThrow(/already registered/)
  })
})
