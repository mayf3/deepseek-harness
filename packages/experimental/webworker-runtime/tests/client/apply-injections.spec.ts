// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { applyIndexInjections } from '../../src/client/apply-injections.ts'

afterEach(() => {
  document.head.innerHTML = ''
  document.body.innerHTML = ''
})

it('ignores script preload hints and executes script sources through the worker loader', async () => {
  const loadScript = vi.fn(async () => {})

  await applyIndexInjections([
    { kind: 'script-preload', src: '/plugins/preload.js' },
    { kind: 'script-src', placement: 'head', src: '/plugins/execute.js' },
  ], loadScript)

  expect(loadScript).toHaveBeenCalledOnce()
  expect(loadScript).toHaveBeenCalledWith('/plugins/execute.js')
  expect(document.querySelector('link[rel="preload"]')).toBeNull()
})
