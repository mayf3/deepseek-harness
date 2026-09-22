import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import PluginInstallLocation, { type Config } from '../src/index.ts'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

async function mount(config: Partial<Config> = {}) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(PluginInstallLocation, PluginInstallLocation.Config(config))
  return { ctx, location: ctx.pluginInstallLocation }
}

it('shares concurrent reads, caches the answer, and refreshes an expired answer', async () => {
  vi.useFakeTimers()
  const first = Promise.withResolvers<Response>()
  const fetch = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(Response.json({ country: 'US' }))
  vi.stubGlobal('fetch', fetch)
  const { location } = await mount({ countryCacheTtlMs: 50 })
  const a = location.country()
  const b = location.country()
  first.resolve(Response.json({ country: 'CN' }))
  expect(await a).toBe('CN')
  expect(await b).toBe('CN')
  expect(await location.country()).toBe('CN')
  expect(fetch).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(50)
  expect(await location.country()).toBe('US')
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('performs no request when disabled', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const { location } = await mount({ countryLookupEnabled: false })
  expect(await location.country()).toBeNull()
  expect(fetch).not.toHaveBeenCalled()
})

it('caches failures as unknown', async () => {
  const fetch = vi.fn().mockRejectedValue(new Error('offline'))
  vi.stubGlobal('fetch', fetch)
  const { location } = await mount()
  expect(await location.country()).toBeNull()
  expect(await location.country()).toBeNull()
  expect(fetch).toHaveBeenCalledOnce()
})

it.each(['timeout', 'dispose'] as const)('settles a pending request on %s', async (cause) => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => { reject(new DOMException('Aborted', 'AbortError')) }, { once: true })
  })))
  const { ctx, location } = await mount({ countryTimeoutMs: 50 })
  const result = location.country()
  if (cause === 'timeout') await vi.advanceTimersByTimeAsync(50)
  else await ctx.fiber.dispose()
  expect(await result).toBeNull()
  if (cause === 'dispose') expect(() => location.country()).toThrow()
})

it.each(['file:///tmp/country', 'https://user:secret@country.example/', 'invalid'])('rejects endpoint %s at load', async (countryEndpoint) => {
  await expect(mount({ countryEndpoint })).rejects.toThrow()
})

it.each([
  { countryTimeoutMs: 0 }, { countryTimeoutMs: 2_147_483_648 },
  { countryMaxResponseBytes: 0 }, { countryCacheTtlMs: -1 },
])('rejects invalid lookup limits %j', (config) => {
  expect(() => PluginInstallLocation.Config(config)).toThrow()
})
