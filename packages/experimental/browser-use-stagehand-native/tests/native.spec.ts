/** SDK cleanup keeps owned Chromium distinct from externally attached Chromium. */

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openNativeBrowser } from '../src/native.ts'
import type { NativeBrowserConfig, NativeBrowserRuntime } from '../src/native.ts'
import { fixture, resetFixture } from './fixtures/stagehand.ts'

vi.mock('@browserbasehq/stagehand', async () => import('./fixtures/stagehand.ts'))

const runtimes: NativeBrowserRuntime[] = []
const config: NativeBrowserConfig = {
  mode: 'launch', headless: true, operationTimeoutMs: 30000, shutdownGraceMs: 5000,
}
const generate = async (): Promise<never> => { throw new Error('Unexpected model call in browser cleanup test') }

beforeEach(() => { resetFixture() })
afterEach(async () => {
  delete fixture.stagehandClose
  await Promise.allSettled(runtimes.splice(0).map(runtime => runtime.close()))
})

it('preserves the external browser when attachment initialization fails', async () => {
  fixture.createError = new Error('Extension initialization failed')
  await expect(openNativeBrowser({ ...config, mode: 'attach', cdpEndpoint: 'http://localhost:9222' }, generate))
    .rejects.toThrow('Extension initialization failed')
  expect(fixture.browsers).toHaveLength(1)
  expect(fixture.browsers[0]?.origin).toBe('connected')
  expect(fixture.browsers[0]?.closed).toBe(false)
  expect(fixture.browsers[0]?.pages.map(page => page.currentURL)).toEqual(['about:blank'])
})

it('closes an owned browser even when Stagehand cleanup fails', async () => {
  const runtime = await openNativeBrowser(config, generate)
  runtimes.push(runtime)
  fixture.stagehandClose = () => { throw new Error('Stagehand cleanup failed') }
  await expect(runtime.close()).rejects.toThrow('Stagehand cleanup failed')
  expect(fixture.browsers[0]?.closed).toBe(true)
})
