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
  it('shares lazy initialization and removes each measurement container after rendering', async () => {
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
    expect(initialize).toHaveBeenCalledOnce()
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
