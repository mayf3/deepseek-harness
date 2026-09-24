import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import * as Analytics from '../src/client/index.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
  vi.unstubAllGlobals()
})
async function setup() {
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  const report = vi.fn().mockResolvedValue({ ok: true, value: undefined })
  ctx.provide('remote', { productAnalytics: { report } } as never)
  ctx.provide('remote.productAnalytics', {} as never)
  await ctx.plugin(Analytics)
  return { ctx, report }
}
it('never collects in Web even when the Host advertises analytics', async () => {
  vi.stubGlobal('__DSH_PRODUCT_ANALYTICS__', true)
  const b = await setup()
  expect(b.ctx.productAnalytics.enabled).toBe(false)
  b.ctx.productAnalytics.track('desktop_app_launch', {})
  expect(b.report).not.toHaveBeenCalled()
})
it('drops disabled events and has no backfill when enabled', async () => {
  vi.stubGlobal('dshDesktop', {})
  vi.stubGlobal('__DSH_PRODUCT_ANALYTICS__', false)
  const b = await setup()
  b.ctx.productAnalytics.track('auth_page_view', {})
  expect(b.report).not.toHaveBeenCalled()
  vi.stubGlobal('__DSH_PRODUCT_ANALYTICS__', true)
  b.ctx.productAnalytics.track('auth_page_click', { button_name: 'sign_in' })
  expect(b.report).toHaveBeenCalledExactlyOnceWith({ eventName: 'auth_page_click', timestamp: expect.any(Number) as number, attributes: { button_name: 'sign_in' } })
})
it('does not retry or propagate transport rejection', async () => {
  vi.stubGlobal('dshDesktop', {})
  vi.stubGlobal('__DSH_PRODUCT_ANALYTICS__', true)
  const b = await setup()
  b.report.mockRejectedValueOnce(new Error('offline'))
  b.ctx.productAnalytics.track('auth_page_view', {})
  await Promise.resolve()
  expect(b.report).toHaveBeenCalledTimes(1)
})

it('does not interrupt an action when Remote access fails synchronously', async () => {
  vi.stubGlobal('dshDesktop', {})
  vi.stubGlobal('__DSH_PRODUCT_ANALYTICS__', true)
  const b = await setup()
  b.report.mockImplementationOnce(() => { throw new Error('Remote namespace detached') })
  expect(() => { b.ctx.productAnalytics.track('auth_page_view', {}) }).not.toThrow()
  await Promise.resolve()
  expect(b.report).toHaveBeenCalledOnce()
})
