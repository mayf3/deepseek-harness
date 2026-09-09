// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const instance = vi.fn()
beforeEach(() => {
  vi.resetModules()
  instance.mockReset()
  vi.doMock('@viz-js/viz', () => ({ instance }))
})
afterEach(() => { vi.doUnmock('@viz-js/viz') })

it('retries failed initialization and reuses the loaded runtime', async () => {
  const renderString = vi.fn().mockReturnValue('<svg xmlns="http://www.w3.org/2000/svg"/>')
  instance.mockRejectedValueOnce(new Error('WASM unavailable')).mockResolvedValue({ renderString })
  const { renderGraphviz } = await import('../src/markdown/graphviz.ts')
  await expect(renderGraphviz('digraph {}', new AbortController().signal)).rejects.toThrow('WASM unavailable')
  await expect(renderGraphviz('digraph {}', new AbortController().signal)).resolves.toContain('data:image/svg+xml')
  await renderGraphviz('digraph {}', new AbortController().signal)
  expect(instance).toHaveBeenCalledTimes(2)
})

it('skips layout after cancellation during runtime loading', async () => {
  const pending = Promise.withResolvers<{ renderString: ReturnType<typeof vi.fn> }>()
  instance.mockReturnValue(pending.promise)
  const { renderGraphviz } = await import('../src/markdown/graphviz.ts')
  const controller = new AbortController()
  const result = renderGraphviz('digraph {}', controller.signal)
  const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  const renderString = vi.fn()
  pending.resolve({ renderString })
  await rejection
  expect(renderString).not.toHaveBeenCalled()
})
