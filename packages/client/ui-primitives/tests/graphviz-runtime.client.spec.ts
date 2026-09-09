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

it('uses theme defaults without rewriting authored DOT attributes', async () => {
  const previous = document.body.getAttribute('style')
  try {
    document.body.style.setProperty('--dsw-alias-label-primary', 'rgb(230, 231, 232)')
    document.body.style.setProperty('--dsw-alias-label-secondary', '#aabbcc')
    document.body.style.setProperty('--dsw-alias-label-tertiary', '#8899aa')
    document.body.style.setProperty('--dsw-alias-bg-layer-2', '#222222')
    const renderString = vi.fn().mockReturnValue('<svg xmlns="http://www.w3.org/2000/svg"/>')
    instance.mockResolvedValue({ renderString })
    const { renderGraphviz } = await import('../src/markdown/graphviz.ts')
    const code = 'digraph { a [color="red"]; a -> b }'
    await renderGraphviz(code, new AbortController().signal)
    expect(renderString).toHaveBeenCalledWith(code, expect.objectContaining({
      nodeAttributes: { color: '#8899aa', fontcolor: '#e6e7e8', fillcolor: '#222222', style: 'filled' },
      edgeAttributes: { color: '#aabbcc', fontcolor: '#e6e7e8' },
    }))
    await renderGraphviz(code, new AbortController().signal, {
      engine: 'neato', format: 'plain', yInvert: true,
      graphAttributes: { ranksep: 1 }, nodeAttributes: { shape: 'box' }, edgeAttributes: { color: 'red' },
    })
    expect(renderString).toHaveBeenLastCalledWith(code, {
      engine: 'neato', format: 'svg', yInvert: true,
      graphAttributes: { bgcolor: 'transparent', fontcolor: '#e6e7e8', ranksep: 1 },
      nodeAttributes: { color: '#8899aa', fontcolor: '#e6e7e8', fillcolor: '#222222', style: 'filled', shape: 'box' },
      edgeAttributes: { color: 'red', fontcolor: '#e6e7e8' },
    })
  } finally {
    if (previous === null) document.body.removeAttribute('style')
    else document.body.setAttribute('style', previous)
  }
})
