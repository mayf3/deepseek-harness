// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SourcePreview } from '../src/markdown/SourcePreview.tsx'
import { CodeBlock } from '../src/markdown/CodeBlock.tsx'
import { renderMermaid } from '../src/markdown/mermaid.ts'
import * as highlight from '../src/markdown/highlight.ts'
import { MarkdownText } from '../src/markdown/MarkdownText.tsx'
import { markdownLabels } from './labels.client.ts'

vi.mock('../src/markdown/mermaid.ts', () => ({ renderMermaid: vi.fn() }))

const labels = {
  diagram: 'Mermaid diagram', error: 'Unable to render this diagram.',
  preview: 'Preview', source: 'Source', zoom: 'Enlarge preview', pending: 'Preparing preview…', close: 'Close preview', interaction: 'Drag to pan, scroll to zoom',
}
const preview = {
  preview: labels.preview, source: labels.source, zoom: labels.zoom, pending: labels.pending,
  close: labels.close, interaction: labels.interaction,
  mermaid: labels, graphviz: labels, svg: labels,
}
const source = 'flowchart LR\n  A[Input] --> B[Preview]'
async function loadPreviewImage() {
  const image = await waitFor(() => {
    const node = document.querySelector<HTMLImageElement>('[data-code-block-preview] img, img')
    expect(node).not.toBeNull()
    return node!
  })
  fireEvent.load(image)
  return image
}

const imageUrl = 'data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E'

afterEach(() => {
  cleanup()
  document.querySelector('[data-test-preview-actions]')?.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
beforeEach(() => { vi.resetAllMocks() })

describe('SourcePreview', () => {
  it('retains a loaded image when a theme render returns the same URL', async () => {
    vi.mocked(renderMermaid).mockResolvedValue(imageUrl)
    const view = render(<SourcePreview render={renderMermaid} code={source} labels={labels} />)
    const previous = document.documentElement.style.colorScheme
    try {
      const image = await loadPreviewImage()
      Object.defineProperty(image, 'complete', { value: true })
      Object.defineProperty(image, 'naturalWidth', { value: 120 })
      await act(async () => { document.documentElement.style.colorScheme = 'dark' })
      expect(renderMermaid).toHaveBeenCalledTimes(2)
      expect(screen.queryByRole('status')).toBeNull()
      expect(screen.getByRole('img')).toBe(image)
    } finally {
      view.unmount()
      document.documentElement.style.colorScheme = previous
    }
  })

  it('keeps the image placeholder until load and reports an image load failure', async () => {
    vi.mocked(renderMermaid).mockResolvedValue(imageUrl)
    const view = render(<SourcePreview render={renderMermaid} code={source} labels={labels} />)
    await waitFor(() => { expect(view.container.querySelector('img')).not.toBeNull() })
    expect(screen.getByRole('status').textContent).toBe(labels.pending)
    expect(screen.queryByRole('img')).toBeNull()
    fireEvent.error(view.container.querySelector('img')!)
    expect(screen.getByRole('status').textContent).toBe(labels.error)
    expect(view.container.querySelector('[data-preview-placeholder]')).toBeNull()
  })

  it('keeps one placeholder through appended and frozen fences without rendering or highlighting source', async () => {
    const html = vi.spyOn(highlight, 'highlightToHtml')
    const tokens = vi.spyOn(highlight.StreamingHighlightSession.prototype, 'update')
    vi.mocked(renderMermaid).mockResolvedValue(imageUrl)
    const props = { labels: { ...markdownLabels, preview } }
    const view = render(<MarkdownText {...props} text="```mermaid\n" streaming />)
    const placeholder = view.container.querySelector('[data-preview-placeholder]')
    expect(placeholder).not.toBeNull()
    for (const text of [
      '```mermaid\nflowchart LR\n',
      `\`\`\`mermaid\n${source}`,
      `\`\`\`mermaid\n${source}\n\`\`\`\n\nOne\n\nTwo\n\nThree`,
    ]) {
      view.rerender(<MarkdownText {...props} text={text} streaming />)
      expect(view.container.querySelector('[data-preview-placeholder]')).toBe(placeholder)
      expect(view.container.querySelector('pre')).toBeNull()
      expect(view.container.querySelector('.md-code-block button')).toBeNull()
    }
    expect(renderMermaid).not.toHaveBeenCalled()
    expect(html).not.toHaveBeenCalled()
    expect(tokens).not.toHaveBeenCalled()
    view.rerender(<MarkdownText {...props} text={`\`\`\`mermaid\n${source}`} />)
    await loadPreviewImage()
    expect(renderMermaid).toHaveBeenCalledTimes(1)
    expect(html).not.toHaveBeenCalled()
    expect(tokens).not.toHaveBeenCalled()
  })

  it('shows source if the owner removes preview support while preview is selected', async () => {
    vi.mocked(renderMermaid).mockResolvedValue(imageUrl)
    const props = { code: source, lang: 'mermaid', ...markdownLabels.code }
    const view = render(<CodeBlock {...props} preview={{ render: renderMermaid, labels }} />)
    await loadPreviewImage()
    view.rerender(<CodeBlock {...props} />)
    expect(view.container.querySelector('pre code')?.textContent).toBe(source)
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('mounts source on demand and retains it across view changes', async () => {
    vi.mocked(renderMermaid).mockResolvedValue(imageUrl)
    const props = { code: source, lang: 'mermaid', ...markdownLabels.code, preview: { render: renderMermaid, labels } }
    const view = render(<CodeBlock {...props} />)
    const image = await loadPreviewImage()
    const sourceView = view.container.querySelector<HTMLElement>('[data-code-block-source-view]')!
    expect(view.container.querySelector('pre')).toBeNull()
    expect(sourceView.getAttribute('aria-hidden')).toBe('true')
    expect(view.container.querySelector('[data-code-block-preview]')?.hasAttribute('hidden')).toBe(false)
    expect(screen.queryByRole('button', { name: 'Reset size' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: labels.source }))
    expect(sourceView.hasAttribute('aria-hidden')).toBe(false)
    const sourceElement = view.container.querySelector('pre')
    expect(sourceElement).not.toBeNull()
    expect(view.container.querySelector('[data-code-block-preview]')?.hasAttribute('hidden')).toBe(true)
    expect(screen.queryByRole('img')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: labels.preview }))
    expect(sourceView.getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByRole('img', { name: labels.diagram })).toBe(image)
    expect(view.container.querySelector('pre')).toBe(sourceElement)
    expect(renderMermaid).toHaveBeenCalledTimes(1)
    view.rerender(<CodeBlock {...props} streaming />)
    expect(view.container.querySelector('[data-code-block-source-view]')).toBeNull()
    expect(screen.getByRole('status').textContent).toBe(labels.pending)
    view.rerender(<CodeBlock {...props} preview={undefined} />)
    expect(view.container.querySelector('pre code')?.textContent).toBe(source)
  })

  it('updates mounted previews on theme changes and ignores obsolete completions', async () => {
    const previous = document.documentElement.style.colorScheme
    const old = Promise.withResolvers<string>()
    vi.mocked(renderMermaid).mockReturnValueOnce(old.promise).mockResolvedValue(imageUrl)
    const view = render(<SourcePreview render={renderMermaid} code={source} labels={labels} />)
    try {
      const oldSignal = vi.mocked(renderMermaid).mock.calls[0]![1]
      await act(async () => { document.documentElement.style.colorScheme = 'dark' })
      expect(oldSignal.aborted).toBe(true)
      const image = await loadPreviewImage()
      await act(async () => { old.resolve('obsolete') })
      expect(image.getAttribute('src')).toBe(imageUrl)
      await act(async () => { document.body.style.setProperty('--unrelated', '1') })
      expect(renderMermaid).toHaveBeenCalledTimes(2)
      await act(async () => { document.documentElement.style.colorScheme = 'light' })
      expect(renderMermaid).toHaveBeenCalledTimes(3)
      view.unmount()
      await act(async () => { document.documentElement.style.colorScheme = 'dark' })
      expect(renderMermaid).toHaveBeenCalledTimes(3)
    } finally {
      view.unmount()
      document.documentElement.style.colorScheme = previous
      document.body.style.removeProperty('--unrelated')
    }
  })
  it('announces pending rendering and enables the persistent zoom action when the image is ready', async () => {
    const pending = Promise.withResolvers<string>()
    vi.mocked(renderMermaid).mockReturnValue(pending.promise)
    const actions = document.createElement('div')
    actions.dataset['testPreviewActions'] = ''
    document.body.append(actions)
    const view = render(<SourcePreview render={renderMermaid} code={source} labels={labels} actions={actions} />)
    const zoom = screen.getByRole<HTMLButtonElement>('button', { name: labels.zoom })
    expect(screen.getByRole('status').textContent).toBe(labels.pending)
    expect(zoom.disabled).toBe(true)
    expect(document.getElementById(zoom.getAttribute('aria-describedby')!)?.textContent).toBe(labels.pending)
    fireEvent.click(zoom)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
    await act(async () => { pending.resolve(imageUrl) })
    await loadPreviewImage()
    expect(screen.getByRole('img', { name: labels.diagram }).getAttribute('src')).toBe(imageUrl)
    expect(view.container.querySelector(`img[alt="${labels.diagram}"]`)).not.toBeNull()
    expect(view.container.querySelector('[data-preview-placeholder]')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('button', { name: labels.zoom })).toBe(zoom)
    expect(zoom.disabled).toBe(false)
    expect(zoom.hasAttribute('aria-describedby')).toBe(false)
  })

  it('opens the rendered image in the viewport dialog and restores focus on close', async () => {
    vi.mocked(renderMermaid).mockResolvedValue(imageUrl)
    const actions = document.createElement('div')
    actions.dataset['testPreviewActions'] = ''
    document.body.append(actions)
    render(<SourcePreview render={renderMermaid} code={source} labels={labels} actions={actions} />)
    await loadPreviewImage()
    const zoom = screen.getByRole('button', { name: labels.zoom })
    zoom.focus()
    fireEvent.click(zoom)
    const dialog = screen.getByRole('dialog', { name: labels.diagram })
    expect(within(dialog).getByRole('img').getAttribute('src')).toBe(imageUrl)
    const close = within(dialog).getByRole('button', { name: labels.close })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: labels.diagram })).toBeNull()
    expect(document.activeElement).toBe(zoom)
  })

  it('retains invalid source and recovers when the source changes', async () => {
    vi.mocked(renderMermaid).mockRejectedValueOnce(new Error('Parse error'))
    const view = render(<SourcePreview render={renderMermaid} code="invalid" labels={labels} />)
    expect((await screen.findByText(labels.error)).getAttribute('role')).toBe('status')
    expect(view.container.querySelector('pre')).toBeNull()
    const next = Promise.withResolvers<string>()
    vi.mocked(renderMermaid).mockReturnValue(next.promise)
    view.rerender(<SourcePreview render={renderMermaid} code={source} labels={labels} />)
    expect(screen.getByRole('status').textContent).toBe(labels.pending)
    expect(view.container.querySelector('pre')).toBeNull()
    await act(async () => { next.resolve(imageUrl) })
    await loadPreviewImage()
    expect(screen.getByRole('img').getAttribute('src')).toBe(imageUrl)
  })

  it('waits for a replacement renderer when the source is unchanged', async () => {
    vi.mocked(renderMermaid).mockResolvedValue(imageUrl)
    const view = render(<SourcePreview render={renderMermaid} code={source} labels={labels} />)
    expect((await loadPreviewImage()).getAttribute('src')).toBe(imageUrl)
    const pending = Promise.withResolvers<string>()
    const replacement = vi.fn(() => pending.promise)
    view.rerender(<SourcePreview render={replacement} code={source} labels={labels} />)
    expect(screen.queryByRole('img')).toBeNull()
    await act(async () => { pending.resolve('data:image/svg+xml;charset=utf-8,replacement') })
    await loadPreviewImage()
    expect(screen.getByRole('img').getAttribute('src')).toContain('replacement')
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
    await loadPreviewImage()
    await act(async () => {
      if (outcome === 'resolve') old.resolve('obsolete-image')
      else old.reject(new Error('obsolete-error'))
    })
    expect(screen.getByRole('img').getAttribute('src')).toBe(imageUrl)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('cancels the owner when unmounted while rendering', async () => {
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
  it('defaults to preview, then retains numbered source and the same image across view changes', async () => {
    vi.mocked(renderMermaid).mockResolvedValue(imageUrl)
    const view = render(<CodeBlock code={source} lang="mermaid" lineNumbers {...markdownLabels.code}
      preview={{ render: renderMermaid, labels }} />)
    expect(view.container.querySelector('[data-line-numbers]')).not.toBeNull()
    const sourceView = view.container.querySelector<HTMLElement>('[data-code-block-source-view]')!
    expect(view.container.querySelector('pre')).toBeNull()
    expect(sourceView.getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByRole('button', { name: labels.preview }).getAttribute('aria-pressed')).toBe('true')
    const diagram = await loadPreviewImage()
    fireEvent.click(screen.getByRole('button', { name: labels.source }))
    await waitFor(() => { expect(view.container.querySelector('pre.shiki')).not.toBeNull() })
    const sourceElement = view.container.querySelector('pre')
    expect([...view.container.querySelectorAll('code > .line')].map(line => line.textContent)).toEqual(source.split('\n'))
    expect(screen.getByRole('button', { name: labels.source }).getAttribute('aria-pressed')).toBe('true')
    expect(diagram.isConnected).toBe(true)
    expect(screen.queryByRole('img')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: labels.preview }))
    expect(screen.getByRole('img', { name: labels.diagram })).toBe(diagram)
    expect(sourceView.getAttribute('aria-hidden')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: labels.source }))
    expect(view.container.querySelector('pre')).toBe(sourceElement)
    expect(sourceView.hasAttribute('aria-hidden')).toBe(false)
    expect(renderMermaid).toHaveBeenCalledTimes(1)
  })

  it('shows a streaming placeholder, then selects preview and copies source from an icon action', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', Object.create(navigator, { clipboard: { value: { writeText } } }))
    vi.mocked(renderMermaid).mockResolvedValue(imageUrl)
    const props = { text: `\`\`\`mermaid\n${source}\n\`\`\``, labels: { ...markdownLabels, preview } }
    const view = render(<MarkdownText {...props} streaming />)
    expect(view.container.querySelector('pre')).toBeNull()
    expect(screen.getByRole('status').textContent).toBe(labels.pending)
    expect(renderMermaid).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: labels.source })).toBeNull()
    expect(screen.queryByRole('button', { name: labels.zoom })).toBeNull()
    view.rerender(<MarkdownText {...props} />)
    expect(view.container.querySelector('pre')).toBeNull()
    expect(view.container.querySelector('[data-code-block-source-view]')?.getAttribute('aria-hidden')).toBe('true')
    const diagram = await loadPreviewImage()
    expect(screen.getByText('mermaid', { exact: true })).toBeDefined()
    expect(screen.getByRole('button', { name: labels.source }).textContent).toBe(labels.source)
    expect(screen.getByRole('button', { name: markdownLabels.code.copyLabel }).textContent).toBe('')
    fireEvent.click(screen.getByRole('button', { name: markdownLabels.code.copyLabel }))
    await screen.findByRole('button', { name: markdownLabels.code.copiedLabel })
    expect(writeText).toHaveBeenCalledWith(source)
    fireEvent.click(screen.getByRole('button', { name: labels.source }))
    expect(view.container.querySelector('pre code')?.textContent).toBe(source)
    expect(screen.queryByRole('img')).toBeNull()
    expect(diagram.isConnected).toBe(true)
    expect(screen.getByText('mermaid', { exact: true })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: labels.preview }))
    expect(screen.getByRole('img', { name: labels.diagram })).toBe(diagram)
    expect(screen.queryByRole('status')).toBeNull()
    expect(renderMermaid).toHaveBeenCalledTimes(1)
  })

  it('returns to the placeholder when a preview starts streaming again', async () => {
    vi.mocked(renderMermaid).mockResolvedValue(imageUrl)
    const props = { code: source, lang: 'mermaid', ...markdownLabels.code, preview: { render: renderMermaid, labels } }
    const view = render(<CodeBlock {...props} />)
    await loadPreviewImage()
    view.rerender(<CodeBlock {...props} code={`${source}\n B --> C`} streaming />)
    expect(view.container.querySelector('pre')).toBeNull()
    expect(screen.getByRole('status').textContent).toBe(labels.pending)
    expect(renderMermaid).toHaveBeenCalledTimes(1)
    view.rerender(<CodeBlock {...props} code={`${source}\n B --> C`} />)
    await loadPreviewImage()
    expect(renderMermaid).toHaveBeenCalledTimes(2)
  })

  it('replaces source zoom with a persistent line-number choice without regenerating the preview', async () => {
    vi.mocked(renderMermaid).mockResolvedValue(imageUrl)
    const view = render(<CodeBlock code={source} lang="mermaid" {...markdownLabels.code}
      preview={{ render: renderMermaid, labels }} />)
    const diagram = await loadPreviewImage()
    fireEvent.click(screen.getByRole('button', { name: labels.source }))
    const block = view.container.querySelector<HTMLElement>('.md-code-block')!
    expect(screen.queryByRole('button', { name: labels.zoom })).toBeNull()
    const numbers = screen.getByRole('button', { name: markdownLabels.code.lineNumbersLabel })
    const firstLine = view.container.querySelector('pre .line')
    expect(numbers.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(numbers)
    expect(numbers.getAttribute('aria-pressed')).toBe('true')
    expect(block.dataset['lineNumbers']).toBe('true')
    expect(view.container.querySelector('pre .line')).toBe(firstLine)
    fireEvent.click(screen.getByRole('button', { name: labels.preview }))
    expect(screen.queryByRole('button', { name: markdownLabels.code.lineNumbersLabel })).toBeNull()
    const zoom = screen.getByRole<HTMLButtonElement>('button', { name: labels.zoom })
    expect(zoom.disabled).toBe(false)
    zoom.focus()
    fireEvent.click(zoom)
    const dialog = screen.getByRole('dialog', { name: labels.diagram })
    expect(within(dialog).getByRole('img').getAttribute('src')).toBe(diagram.getAttribute('src'))
    fireEvent.click(within(dialog).getByRole('button', { name: labels.close }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(zoom)
    fireEvent.click(screen.getByRole('button', { name: labels.source }))
    expect(screen.getByRole('button', { name: markdownLabels.code.lineNumbersLabel }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: markdownLabels.code.lineNumbersLabel }))
    expect(block.hasAttribute('data-line-numbers')).toBe(false)
    expect(renderMermaid).toHaveBeenCalledTimes(1)
  })

  it('keeps pending work through a source visit and retains a failure without retrying on toggles', async () => {
    const pending = Promise.withResolvers<string>()
    vi.mocked(renderMermaid).mockReturnValue(pending.promise)
    const view = render(<CodeBlock code={source} lang="mermaid" {...markdownLabels.code}
      preview={{ render: renderMermaid, labels }} />)
    const signal = vi.mocked(renderMermaid).mock.calls[0]![1]
    const zoom = screen.getByRole<HTMLButtonElement>('button', { name: labels.zoom })
    fireEvent.click(screen.getByRole('button', { name: labels.source }))
    expect(view.container.querySelector('pre code')?.textContent).toBe(source)
    expect(signal.aborted).toBe(false)
    expect(screen.queryByRole('button', { name: labels.zoom })).toBeNull()
    expect(zoom.disabled).toBe(true)
    expect(document.getElementById(zoom.getAttribute('aria-describedby')!)?.textContent).toBe(labels.pending)
    await act(async () => { pending.reject(new Error('Parse error')) })
    expect(zoom.disabled).toBe(true)
    expect(document.getElementById(zoom.getAttribute('aria-describedby')!)?.textContent).toBe(labels.error)
    fireEvent.click(screen.getByRole('button', { name: labels.preview }))
    expect(screen.getByRole('status').textContent).toBe(labels.error)
    expect(view.container.querySelector('[data-code-block-preview] pre')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: labels.source }))
    fireEvent.click(screen.getByRole('button', { name: labels.preview }))
    expect(renderMermaid).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status').textContent).toBe(labels.error)
  })

  it('leaves other languages and consumers without preview labels as code', () => {
    const view = render(<MarkdownText text={`\`\`\`mermaid\n${source}\n\`\`\``} labels={markdownLabels} />)
    expect(view.container.querySelector('pre code')?.textContent).toBe(source)
    view.rerender(<MarkdownText text={'```text\nflowchart LR\n```'} labels={{ ...markdownLabels, preview }} />)
    expect(view.container.querySelector('pre code')?.textContent).toBe('flowchart LR')
    expect(renderMermaid).not.toHaveBeenCalled()
  })
})
