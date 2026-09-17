// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const initialize = vi.fn()
const renderDiagram = vi.fn()
const getDiagramFromText = vi.fn()
const importRuntime = vi.fn(() => ({ default: { initialize, render: renderDiagram, mermaidAPI: { getDiagramFromText } } }))

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  getDiagramFromText.mockResolvedValue({ type: 'sequence', db: {} })
  vi.doMock('mermaid', importRuntime)
})
afterEach(() => { vi.doUnmock('mermaid') })

describe('Mermaid runtime', () => {
  it('rejects image nodes before layout and leaves the queue available', async () => {
    const { renderMermaid } = await import('../src/markdown/mermaid.ts')
    getDiagramFromText.mockResolvedValueOnce({ type: 'flowchart-v2', db: {
      getVertices: () => new Map([['A', { img: 'https://preview.invalid/image' }]]),
    } })
    await expect(renderMermaid('image', new AbortController().signal)).rejects.toThrow('image nodes')
    expect(renderDiagram).not.toHaveBeenCalled()
    getDiagramFromText.mockResolvedValueOnce({ type: 'flowchart-v2', db: {
      getVertices: () => new Map([['A', {}]]),
    } })
    renderDiagram.mockResolvedValue({ svg: '<svg/>' })
    await expect(renderMermaid('plain', new AbortController().signal)).resolves.toContain('data:image/svg+xml')
    expect(renderDiagram).toHaveBeenCalledOnce()
  })

  it('allows another attempt after the runtime import fails', async () => {
    const importError = new Error('runtime unavailable')
    importRuntime.mockImplementationOnce(() => { throw importError })
    const { renderMermaid } = await import('../src/markdown/mermaid.ts')
    await expect(renderMermaid('first', new AbortController().signal)).rejects.toMatchObject({ cause: importError })
    expect(initialize).not.toHaveBeenCalled()
    vi.doMock('mermaid', importRuntime)
    renderDiagram.mockResolvedValue({ svg: '<svg/>' })
    await expect(renderMermaid('retry', new AbortController().signal)).resolves.toContain('data:image/svg+xml')
    expect(renderDiagram).toHaveBeenCalledOnce()
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

  it('does not import the runtime for cancelled queued work', async () => {
    const { renderMermaid } = await import('../src/markdown/mermaid.ts')
    const controller = new AbortController()
    controller.abort()
    await expect(renderMermaid('unused', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(renderDiagram).not.toHaveBeenCalled()
    expect(importRuntime).not.toHaveBeenCalled()
  })

  it('skips layout after cancellation while loading the diagram parser', async () => {
    const parsed = Promise.withResolvers<{ type: string; db: object }>()
    getDiagramFromText.mockReturnValueOnce(parsed.promise)
    const { renderMermaid } = await import('../src/markdown/mermaid.ts')
    const controller = new AbortController()
    const result = renderMermaid('sequenceDiagram', controller.signal)
    const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => { expect(getDiagramFromText).toHaveBeenCalledOnce() })
    controller.abort()
    parsed.resolve({ type: 'sequence', db: {} })
    await rejection
    expect(renderDiagram).not.toHaveBeenCalled()
    renderDiagram.mockResolvedValue({ svg: '<svg/>' })
    await expect(renderMermaid('next', new AbortController().signal)).resolves.toContain('data:image/svg+xml')
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
