// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const initialize = vi.fn()
const renderDiagram = vi.fn()

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  vi.doMock('mermaid', () => ({ default: { initialize, render: renderDiagram } }))
})
afterEach(() => { vi.doUnmock('mermaid') })

describe('Mermaid runtime', () => {
  it('allows another attempt after the runtime import fails', async () => {
    vi.doMock('mermaid', () => { throw new Error('runtime unavailable') })
    const { renderMermaid } = await import('../src/markdown/mermaid.ts')
    await expect(renderMermaid('first', new AbortController().signal)).rejects.toThrow()
    expect(initialize).not.toHaveBeenCalled()
    vi.doMock('mermaid', () => ({ default: { initialize, render: renderDiagram } }))
    renderDiagram.mockResolvedValue({ svg: '<svg/>' })
    await expect(renderMermaid('retry', new AbortController().signal)).resolves.toContain('data:image/svg+xml')
    expect(renderDiagram).toHaveBeenCalledOnce()
  })

  it('accepts native configuration without weakening preview restrictions', async () => {
    const { renderMermaid } = await import('../src/markdown/mermaid.ts')
    renderDiagram.mockResolvedValue({ svg: '<svg/>' })
    await renderMermaid('flowchart LR', new AbortController().signal, {
      // oxlint-disable-next-line typescript/no-deprecated
      layout: 'dagre', flowchart: { nodeSpacing: 40, htmlLabels: true },
      themeVariables: { primaryColor: '#123456' },
      securityLevel: 'loose', startOnLoad: true, suppressErrorRendering: false, htmlLabels: true, secure: [],
    })
    expect(initialize.mock.calls[0]![0]).toMatchObject({
      layout: 'dagre', flowchart: { nodeSpacing: 40, htmlLabels: false },
      themeVariables: { primaryColor: '#123456', darkMode: false },
      securityLevel: 'strict', startOnLoad: false, suppressErrorRendering: true, htmlLabels: false,
    })
    expect(initialize.mock.calls[0]![0]).toHaveProperty('secure', expect.arrayContaining(['securityLevel']))
  })

  it('reuses the runtime and removes each measurement container after rendering', async () => {
    const { renderMermaid } = await import('../src/markdown/mermaid.ts')
    expect(initialize).not.toHaveBeenCalled()
    const stages: HTMLElement[] = []
    const ids: string[] = []
    renderDiagram.mockImplementation(async (id: string, code: string, stage: HTMLElement) => {
      expect(stage.isConnected).toBe(true)
      expect(stage.getAttribute('aria-hidden')).toBe('true')
      stages.push(stage)
      ids.push(id)
      return { svg: `<svg>${code}</svg>` }
    })
    const results = await Promise.all([
      renderMermaid('中文', new AbortController().signal),
      renderMermaid('second', new AbortController().signal),
    ])
    expect(initialize).toHaveBeenCalledTimes(2)
    expect(initialize).toHaveBeenCalledWith(expect.objectContaining({
      startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, htmlLabels: false,
      secure: [
        'secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges',
        'suppressErrorRendering', 'theme', 'themeVariables', 'themeCSS', 'htmlLabels', 'flowchart',
      ],
    }))
    expect(results.map(url => decodeURIComponent(url.split(',')[1]!))).toEqual(['<svg>中文</svg>', '<svg>second</svg>'])
    expect(new Set(ids).size).toBe(2)
    expect(stages.every(stage => !stage.isConnected)).toBe(true)
  })

  it('keeps theme initialization with its render and recovers the queue after failure', async () => {
    const { renderMermaid } = await import('../src/markdown/mermaid.ts')
    const first = Promise.withResolvers<{ svg: string }>()
    renderDiagram.mockReturnValueOnce(first.promise).mockResolvedValue({ svg: '<svg/>' })
    const light = renderMermaid('first', new AbortController().signal)
    const failure = expect(light).rejects.toThrow('invalid')
    await vi.waitFor(() => { expect(renderDiagram).toHaveBeenCalledOnce() })
    const previous = document.documentElement.style.colorScheme
    try {
      document.documentElement.style.colorScheme = 'dark'
      const dark = renderMermaid('second', new AbortController().signal)
      await Promise.resolve()
      expect(initialize).toHaveBeenCalledOnce()
      first.reject(new Error('invalid'))
      await failure
      await dark
      expect(initialize.mock.calls[1]![0]).toMatchObject({ themeVariables: { darkMode: true } })
    } finally {
      document.documentElement.style.colorScheme = previous
    }
  })

  it('removes measurement DOM even when Mermaid rejects', async () => {
    const { renderMermaid } = await import('../src/markdown/mermaid.ts')
    let stage: HTMLElement | undefined
    const error = new Error('bad diagram')
    renderDiagram.mockImplementation(async (_id: string, _code: string, target: HTMLElement) => {
      stage = target
      target.innerHTML = '<svg>partial render</svg>'
      throw error
    })
    await expect(renderMermaid('bad', new AbortController().signal)).rejects.toBe(error)
    expect(stage?.isConnected).toBe(false)
  })

  it('preserves intrinsic diagram size instead of stretching percentage-width SVG images', async () => {
    const { renderMermaid } = await import('../src/markdown/mermaid.ts')
    renderDiagram.mockResolvedValue({ svg: '<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 420 180"/>' })
    const url = await renderMermaid('flowchart LR', new AbortController().signal)
    const svg = new DOMParser().parseFromString(decodeURIComponent(url.split(',')[1]!), 'image/svg+xml').documentElement
    expect(svg.getAttribute('width')).toBe('420')
    expect(svg.getAttribute('height')).toBe('180')
  })

  it('does not start cancelled work after loading the runtime', async () => {
    const { renderMermaid } = await import('../src/markdown/mermaid.ts')
    const controller = new AbortController()
    controller.abort()
    await expect(renderMermaid('unused', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(renderDiagram).not.toHaveBeenCalled()
  })

  it('allows another attempt after runtime initialization fails', async () => {
    const { renderMermaid } = await import('../src/markdown/mermaid.ts')
    initialize.mockImplementationOnce(() => { throw new Error('initialization failed') })
    await expect(renderMermaid('first', new AbortController().signal)).rejects.toThrow('initialization failed')
    renderDiagram.mockResolvedValue({ svg: '<svg/>' })
    await expect(renderMermaid('retry', new AbortController().signal)).resolves.toContain('data:image/svg+xml')
    expect(initialize).toHaveBeenCalledTimes(2)
  })
})
