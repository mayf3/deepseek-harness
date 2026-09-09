// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SourcePreview } from '../src/markdown/SourcePreview.tsx'
import { CodeBlock } from '../src/markdown/CodeBlock.tsx'
import { renderMermaid } from '../src/markdown/mermaid.ts'
import { MarkdownText } from '../src/markdown/MarkdownText.tsx'
import { markdownLabels } from './labels.client.ts'

vi.mock('../src/markdown/mermaid.ts', () => ({ renderMermaid: vi.fn() }))

const labels = {
  diagram: 'Mermaid diagram', loading: 'Rendering diagram…', error: 'Unable to render this diagram.',
  preview: 'Preview', source: 'Source',
}
const preview = {
  preview: labels.preview, source: labels.source,
  mermaid: labels, graphviz: labels, svg: labels, html: labels,
}
const source = 'flowchart LR\n  A[Input] --> B[Preview]'
const imageUrl = 'data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
beforeEach(() => { vi.resetAllMocks() })

describe('SourcePreview', () => {
  it('shows loading until rendering completes, then displays an image without inserting SVG', async () => {
    const pending = Promise.withResolvers<string>()
    vi.mocked(renderMermaid).mockReturnValue(pending.promise)
    const view = render(<SourcePreview render={renderMermaid} code={source} labels={labels} />)
    expect(screen.getByRole('status').textContent).toBe(labels.loading)
    expect(screen.queryByRole('img')).toBeNull()
    await act(async () => { pending.resolve(imageUrl) })
    expect(screen.getByRole('img', { name: labels.diagram }).getAttribute('src')).toBe(imageUrl)
    expect(view.container.querySelector('svg')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('retains invalid source and recovers when the source changes', async () => {
    vi.mocked(renderMermaid).mockRejectedValueOnce(new Error('Parse error'))
    const view = render(<SourcePreview render={renderMermaid} code="invalid" labels={labels} />)
    expect((await screen.findByText(labels.error)).getAttribute('role')).toBe('status')
    expect(view.container.querySelector('pre code')?.textContent).toBe('invalid')
    const next = Promise.withResolvers<string>()
    vi.mocked(renderMermaid).mockReturnValue(next.promise)
    view.rerender(<SourcePreview render={renderMermaid} code={source} labels={labels} />)
    expect(screen.getByRole('status').textContent).toBe(labels.loading)
    expect(view.container.querySelector('pre')).toBeNull()
    await act(async () => { next.resolve(imageUrl) })
    expect(screen.getByRole('img').getAttribute('src')).toBe(imageUrl)
  })

  it.each(['resolve', 'reject'] as const)('ignores a stale %s after a newer source finishes', async (outcome) => {
    const old = Promise.withResolvers<string>()
    const next = Promise.withResolvers<string>()
    vi.mocked(renderMermaid).mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
    const view = render(<SourcePreview render={renderMermaid} code="old" labels={labels} />)
    const oldSignal = vi.mocked(renderMermaid).mock.calls[0]![1]
    view.rerender(<SourcePreview render={renderMermaid} code={source} labels={labels} />)
    expect(oldSignal.aborted).toBe(true)
    await act(async () => { next.resolve(imageUrl) })
    await act(async () => {
      if (outcome === 'resolve') old.resolve('obsolete-image')
      else old.reject(new Error('obsolete-error'))
    })
    expect(screen.getByRole('img').getAttribute('src')).toBe(imageUrl)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('cancels the owner when unmounted while loading', async () => {
    const pending = Promise.withResolvers<string>()
    vi.mocked(renderMermaid).mockReturnValue(pending.promise)
    const view = render(<SourcePreview render={renderMermaid} code={source} labels={labels} />)
    const signal = vi.mocked(renderMermaid).mock.calls[0]![1]
    view.unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => { pending.reject(new Error('cancelled')) })
    expect(screen.queryByRole('img')).toBeNull()
  })
})

describe('Markdown Mermaid fences', () => {
  it('retains a preview when switching to numbered source', async () => {
    vi.mocked(renderMermaid).mockResolvedValue(imageUrl)
    const view = render(<CodeBlock code={source} lang="mermaid" lineNumbers {...markdownLabels.code}
      preview={{
        content: <SourcePreview render={renderMermaid} code={source} labels={labels} />,
        previewLabel: labels.preview, sourceLabel: labels.source,
      }} />)
    const diagram = await screen.findByRole('img', { name: labels.diagram })
    expect(view.container.querySelector('[data-line-numbers]')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: labels.source }))
    expect([...view.container.querySelectorAll('code > .line')].map(line => line.textContent)).toEqual(source.split('\n'))
    expect(diagram.isConnected).toBe(true)
    expect(screen.queryByRole('img')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: labels.preview }))
    expect(screen.getByRole('img', { name: labels.diagram })).toBe(diagram)
    expect(renderMermaid).toHaveBeenCalledOnce()
  })

  it('keeps streaming source literal, then offers preview, source and source copying', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', Object.create(navigator, { clipboard: { value: { writeText } } }))
    vi.mocked(renderMermaid).mockResolvedValue(imageUrl)
    const props = { text: `\`\`\`mermaid\n${source}\n\`\`\``, labels: { ...markdownLabels, preview } }
    const view = render(<MarkdownText {...props} streaming />)
    expect(view.container.querySelector('pre code')?.textContent).toBe(source)
    expect(renderMermaid).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: labels.source })).toBeNull()
    view.rerender(<MarkdownText {...props} />)
    const diagram = await screen.findByRole('img', { name: labels.diagram })
    expect(screen.queryByText('mermaid')).toBeNull()
    expect(screen.getByRole('button', { name: labels.source }).textContent).toBe('')
    expect(screen.getByRole('button', { name: markdownLabels.code.copyLabel }).textContent).toBe('')
    fireEvent.click(screen.getByRole('button', { name: markdownLabels.code.copyLabel }))
    await screen.findByRole('button', { name: markdownLabels.code.copiedLabel })
    expect(writeText).toHaveBeenCalledWith(source)
    fireEvent.click(screen.getByRole('button', { name: labels.source }))
    expect(view.container.querySelector('pre code')?.textContent).toBe(source)
    expect(screen.queryByRole('img')).toBeNull()
    expect(diagram.isConnected).toBe(true)
    expect(screen.queryByText('mermaid')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: labels.preview }))
    expect(screen.getByRole('img', { name: labels.diagram })).toBe(diagram)
    expect(screen.queryByRole('status')).toBeNull()
    expect(renderMermaid).toHaveBeenCalledOnce()
  })

  it('leaves other languages and consumers without preview labels as code', () => {
    const view = render(<MarkdownText text={`\`\`\`mermaid\n${source}\n\`\`\``} labels={markdownLabels} />)
    expect(view.container.querySelector('pre code')?.textContent).toBe(source)
    view.rerender(<MarkdownText text={'```text\nflowchart LR\n```'} labels={{ ...markdownLabels, preview }} />)
    expect(view.container.querySelector('pre code')?.textContent).toBe('flowchart LR')
    expect(renderMermaid).not.toHaveBeenCalled()
  })
})
