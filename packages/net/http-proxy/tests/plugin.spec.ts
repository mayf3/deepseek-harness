import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { getGlobalDispatcher } from 'undici'
import { PROXY_ENV_NAMES } from '../src/policy.ts'
import * as HttpProxy from '../src/index.ts'
import * as HttpProxyInvariant from '../src/invariant.ts'

const PROXY = 'http://127.0.0.1:7897'

// `scripts/test-proxy-environment.ts` clears the machine's proxy variables before any suite runs,
// so each test starts from nothing and only has to undo what `withEnv` set.
afterEach(() => {
  for (const name of PROXY_ENV_NAMES) Reflect.deleteProperty(process.env, name)
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
