// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownText } from '../src/markdown/MarkdownText.tsx'
import { renderGraphviz } from '../src/markdown/graphviz.ts'
import { renderHtml, renderSvg } from '../src/markdown/preview-document.ts'
import { markdownLabels } from './labels.client.ts'

const status = { loading: 'Loading', error: 'Cannot preview' }
const preview = {
  mermaid: { ...status, diagram: 'Mermaid diagram' },
  graphviz: { ...status, diagram: 'Graphviz diagram' },
  svg: { ...status, diagram: 'SVG preview' },
  html: { ...status, diagram: 'HTML preview' },
  preview: 'Preview', source: 'Source',
}
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><text y="30">示例</text></svg>'
const cases = [
  ['graphviz', 'digraph { Input -> Preview }', preview.graphviz.diagram],
  ['dot', 'digraph { Input -> Preview }', preview.graphviz.diagram],
  ['svg', svg, preview.svg.diagram],
  ['html', '<style>h1 { color: green }</style><h1>Example</h1>', preview.html.diagram],
] as const

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('Markdown fence previews', () => {
  it('renders real DOT', async () => { await renderGraphviz('digraph { Input -> Preview }', new AbortController().signal) })
  it.each(cases)('settles %s into an isolated default preview and copies original source in both views', async (lang, code, title) => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', Object.create(navigator, { clipboard: { value: { writeText } } }))
    const props = { text: `\`\`\`${lang}\n${code}\n\`\`\``, labels: { ...markdownLabels, preview } }
    const view = render(<MarkdownText {...props} streaming />)
    expect(view.container.querySelector('iframe')).toBeNull()
    expect(view.container.querySelector('pre code')?.textContent).toBe(code)
    view.rerender(<MarkdownText {...props} />)
    const findPreview = async () => lang === 'html' ? await screen.findByTitle(title) : await screen.findByRole('img', { name: title })
    const element = await findPreview()
    if (lang === 'html') {
      expect(element.getAttribute('sandbox')).toBe('')
      expect(element.getAttribute('referrerpolicy')).toBe('no-referrer')
      expect(element.getAttribute('srcdoc')).toContain('Content-Security-Policy')
    } else {
      expect(element.getAttribute('src')).toMatch(/^data:image\/svg\+xml/)
      expect(view.container.querySelector('iframe')).toBeNull()
      expect(element.parentElement!.querySelector('svg')).toBeNull()
    }
    expect(view.container.querySelector('pre code')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    expect(view.container.querySelector('pre code')?.textContent).toBe(code)
    expect(element.closest('[hidden]')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: markdownLabels.code.copyLabel }))
    await waitFor(() => { expect(writeText).toHaveBeenCalledWith(code) })
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(await findPreview()).toBe(element)
    expect(element.closest('[hidden]')).toBeNull()
    view.unmount()
    render(<MarkdownText {...props} />)
    await findPreview()
    fireEvent.click(screen.getByRole('button', { name: markdownLabels.code.copyLabel }))
    await waitFor(() => { expect(writeText).toHaveBeenCalledTimes(2) })
  })

  it.each(['svg', 'graphviz'])('retains invalid %s source and recovers after replacement', async (lang) => {
    const view = render(<MarkdownText text={`\`\`\`${lang}\nbroken\n\`\`\``} labels={{ ...markdownLabels, preview }} />)
    await screen.findByText(status.error)
    expect(view.container.querySelector('pre code')?.textContent).toBe('broken')
    view.rerender(<MarkdownText text={`\`\`\`svg\n${svg}\n\`\`\``} labels={{ ...markdownLabels, preview }} />)
    await screen.findByRole('img', { name: preview.svg.diagram })
    expect(screen.queryByText(status.error)).toBeNull()
  })

  it('requires an opted-in code fence and leaves raw HTML and other languages unrendered', () => {
    const view = render(<MarkdownText text={'```html\n<h1>Example</h1>\n```'} labels={markdownLabels} />)
    expect(view.container.querySelector('pre code')?.textContent).toBe('<h1>Example</h1>')
    view.rerender(<MarkdownText text={'<h1>Example</h1>\n\n```xml\n<node />\n```'} labels={{ ...markdownLabels, preview }} />)
    expect(view.container.querySelector('iframe')).toBeNull()
    expect(view.container.querySelector('h1')).toBeNull()
  })
})

describe('static preview documents', () => {
  it('preserves HTML styling while removing scripts, navigation, and nested documents', () => {
    const doc = renderHtml(`<!doctype html><html><head><style>h1 { color: green }</style>
      <meta http-equiv="refresh" content="0;url=https://example.com"><base href="https://example.com"></head>
      <body onload="alert(1)"><h1>Example</h1><script>alert(1)</script>
      <a href="https://example.com">Link</a><iframe srcdoc="unsafe"></iframe>
      <form action="https://example.com"><button formaction="https://example.com">Submit</button></form></body></html>`, new AbortController().signal)
    const parsed = new DOMParser().parseFromString(doc, 'text/html')
    expect(parsed.querySelector('h1')?.textContent).toBe('Example')
    expect(parsed.querySelector('style')?.textContent).toBe('h1 { color: green }')
    expect(parsed.querySelector('script, iframe, base, [href], [action], [formaction], [onload]')).toBeNull()
    expect(parsed.querySelectorAll('meta[http-equiv]').length).toBe(1)
    expect(parsed.querySelector('meta[http-equiv]')?.getAttribute('content')).toContain("default-src 'none'")
  })

  it('encodes SVG as an image rather than executable document markup', () => {
    const code = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert("test")</script></svg>'
    const url = renderSvg(code, new AbortController().signal)
    expect(url).toMatch(/^data:image\/svg\+xml;charset=utf-8,/)
    expect(decodeURIComponent(url.slice(url.indexOf(',') + 1))).toBe(code)
  })

  it.each(['<html/>', '<svg/>', '<svg xmlns="http://www.w3.org/2000/svg"><g></svg>'])('rejects non-SVG or malformed XML: %s', (code) => {
    expect(() => renderSvg(code, new AbortController().signal)).toThrow('Invalid SVG document')
  })

  it.each([renderHtml, renderSvg])('does not prepare a cancelled document', (renderDocument) => {
    const controller = new AbortController()
    controller.abort()
    expect(() => renderDocument(svg, controller.signal)).toThrow(controller.signal.reason)
  })
})
