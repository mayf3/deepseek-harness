// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownText } from '../src/markdown/MarkdownText.tsx'
import { renderGraphviz } from '../src/markdown/graphviz.ts'
import { renderSvg } from '../src/markdown/svg.ts'
import { markdownLabels } from './labels.client.ts'

const status = { error: 'Cannot preview' }
const preview = {
  mermaid: { ...status, diagram: 'Mermaid diagram' },
  graphviz: { ...status, diagram: 'Graphviz diagram' },
  svg: { ...status, diagram: 'SVG preview' },
  preview: 'Preview', source: 'Source', zoom: 'Enlarge preview', pending: 'Preparing preview…', close: 'Close preview', interaction: 'Drag to pan, scroll to zoom',
}
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><text y="30">示例</text></svg>'
const cases = [
  ['graphviz', 'digraph { Input -> Preview }', preview.graphviz.diagram],
  ['dot', 'digraph { Input -> Preview }', preview.graphviz.diagram],
  ['svg', svg, preview.svg.diagram],
] as const

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('Markdown fence previews', () => {
  it('renders real DOT', async () => { await renderGraphviz('digraph { Input -> Preview }', new AbortController().signal) })
  it.each(cases)('selects settled %s preview and retains source and image across view changes', async (lang, code, title) => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', Object.create(navigator, { clipboard: { value: { writeText } } }))
    const props = { text: `\`\`\`${lang}\n${code}\n\`\`\``, labels: { ...markdownLabels, preview } }
    const view = render(<MarkdownText {...props} streaming />)
    expect(view.container.querySelector('iframe')).toBeNull()
    expect(view.container.querySelector('pre')).toBeNull()
    expect(screen.getByRole('status').textContent).toBe(preview.pending)
    view.rerender(<MarkdownText {...props} />)
    expect(view.container.querySelector('pre')).toBeNull()
    expect(view.container.querySelector('[data-code-block-source-view]')?.getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByRole('button', { name: 'Preview' }).getAttribute('aria-pressed')).toBe('true')
    const findPreview = async () => {
      const img = await waitFor(() => {
        const node = document.querySelector('img')
        expect(node).not.toBeNull()
        return node!
      })
      fireEvent.load(img)
      return screen.getByRole('img', { name: title })
    }
    const element = await findPreview()
    expect(element.getAttribute('src')).toMatch(/^data:image\/svg\+xml/)
    expect(view.container.querySelector('iframe')).toBeNull()
    expect(view.container.querySelector('[data-code-block-preview]')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    expect(view.container.querySelector('pre code')?.textContent).toBe(code)
    expect(view.container.querySelector('[data-code-block-preview]')?.hasAttribute('hidden')).toBe(true)
    expect(screen.queryByRole('img', { name: title })).toBeNull()
    expect(element.isConnected).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: markdownLabels.code.copyLabel }))
    await waitFor(() => { expect(writeText).toHaveBeenCalledWith(code) })
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(await findPreview()).toBe(element)
    view.unmount()
    render(<MarkdownText {...props} />)
    await findPreview()
    fireEvent.click(screen.getByRole('button', { name: markdownLabels.code.copyLabel }))
    await waitFor(() => { expect(writeText).toHaveBeenCalledTimes(2) })
  })

  it.each(['svg', 'graphviz'])('retains invalid %s source and recovers after replacement', async (lang) => {
    const view = render(<MarkdownText text={`\`\`\`${lang}\nbroken\n\`\`\``} labels={{ ...markdownLabels, preview }} />)
    await waitFor(() => { expect(screen.getByRole('status').textContent).toBe(status.error) })
    expect(view.container.querySelector('pre')).toBeNull()
    expect(view.container.querySelector('[data-code-block-source-view]')?.getAttribute('aria-hidden')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    expect(view.container.querySelector('pre code')?.textContent).toBe('broken')
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    view.rerender(<MarkdownText text={`\`\`\`svg\n${svg}\n\`\`\``} labels={{ ...markdownLabels, preview }} />)
    await waitFor(() => { expect(view.container.querySelector('img')).not.toBeNull() })
    fireEvent.load(view.container.querySelector('img')!)
    await screen.findByRole('img', { name: preview.svg.diagram })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('requires an opted-in supported code fence and leaves HTML and other languages unrendered', () => {
    const view = render(<MarkdownText text={'```html\n<h1>Example</h1>\n```'} labels={{ ...markdownLabels, preview }} />)
    expect(view.container.querySelector('pre code')?.textContent).toBe('<h1>Example</h1>')
    expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull()
    view.rerender(<MarkdownText text={'<h1>Example</h1>\n\n```xml\n<node />\n```'} labels={{ ...markdownLabels, preview }} />)
    expect(view.container.querySelector('iframe')).toBeNull()
    expect(view.container.querySelector('h1')).toBeNull()
  })
})

describe('static SVG previews', () => {
  it('encodes SVG as an image rather than executable document markup', () => {
    const code = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert("test")</script></svg>'
    const url = renderSvg(code, new AbortController().signal)
    expect(url).toMatch(/^data:image\/svg\+xml;charset=utf-8,/)
    expect(decodeURIComponent(url.slice(url.indexOf(',') + 1))).toBe(code)
  })

  it.each(['<html/>', '<svg/>', '<svg xmlns="http://www.w3.org/2000/svg"><g></svg>'])('rejects non-SVG or malformed XML: %s', (code) => {
    expect(() => renderSvg(code, new AbortController().signal)).toThrow('Invalid SVG document')
  })

  it('does not prepare a cancelled SVG', () => {
    const controller = new AbortController()
    controller.abort()
    expect(() => renderSvg(svg, controller.signal)).toThrow(controller.signal.reason)
  })
})
