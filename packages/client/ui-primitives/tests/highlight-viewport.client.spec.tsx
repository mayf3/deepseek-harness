// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SourcePreview } from '../src/markdown/SourcePreview.tsx'
import { ReadBlock } from '../src/ReadBlock.tsx'
import { CodeBlock } from '../src/markdown/CodeBlock.tsx'
import { markdownLabels, readBlockLabels } from './labels.client.ts'

class IntersectionObserverStub {
  static instances: IntersectionObserverStub[] = []

  readonly observed = new Set<Element>()
  readonly unobserved = new Set<Element>()
  disconnected = false

  constructor(private readonly callback: IntersectionObserverCallback) {
    IntersectionObserverStub.instances.push(this)
  }

  observe(element: Element): void {
    this.observed.add(element)
  }

  unobserve(element: Element): void {
    this.observed.delete(element)
    this.unobserved.add(element)
  }

  disconnect(): void {
    this.disconnected = true
    this.observed.clear()
  }

  takeRecords(): IntersectionObserverEntry[] {
    return []
  }

  intersect(element: Element, isIntersecting: boolean): void {
    this.callback(
      [{ target: element, isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    )
  }
}

beforeEach(() => {
  IntersectionObserverStub.instances = []
  vi.stubGlobal('IntersectionObserver', IntersectionObserverStub)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('viewport-activated syntax highlighting', () => {
  it('keeps offscreen blocks plain and permanently activates only intersecting blocks', async () => {
    const view = render(
      <>
        <CodeBlock code="const first = 1" lang="ts" {...markdownLabels.code} />
        <CodeBlock code="const second = 2" lang="ts" {...markdownLabels.code} />
        <CodeBlock code="const third = 3" lang="ts" {...markdownLabels.code} />
      </>,
    )
    const blocks = [...view.container.querySelectorAll('.md-code-block')]
    expect(blocks).toHaveLength(3)
    expect(IntersectionObserverStub.instances).toHaveLength(1)
    const observer = IntersectionObserverStub.instances[0]!
    expect(observer.observed.size).toBe(3)
    expect(view.container.querySelectorAll('pre.shiki')).toHaveLength(0)

    act(() => { observer.intersect(blocks[0]!, false) })
    expect(view.container.querySelectorAll('pre.shiki')).toHaveLength(0)

    act(() => {
      observer.intersect(blocks[0]!, true)
      observer.intersect(blocks[1]!, true)
    })
    await waitFor(() => {
      expect(blocks[0]!.querySelector('pre.shiki')).not.toBeNull()
      expect(blocks[1]!.querySelector('pre.shiki')).not.toBeNull()
    })
    expect(blocks[2]!.querySelector('pre.shiki')).toBeNull()
    expect(observer.unobserved.has(blocks[0]!)).toBe(true)

    act(() => { observer.intersect(blocks[0]!, false) })
    expect(blocks[0]!.querySelector('pre.shiki')).not.toBeNull()

    view.rerender(
      <>
        <CodeBlock code="const first = 10" lang="ts" {...markdownLabels.code} />
        <CodeBlock code="const second = 2" lang="ts" {...markdownLabels.code} />
        <CodeBlock code="const third = 3" lang="ts" {...markdownLabels.code} />
      </>,
    )
    expect(blocks[0]!.querySelector('pre.shiki')?.textContent).toBe('const first = 10')

    act(() => { observer.intersect(blocks[2]!, true) })
    await waitFor(() => { expect(blocks[2]!.querySelector('pre.shiki')).not.toBeNull() })
    expect(observer.disconnected).toBe(true)
  })

  it.each([
    ['mermaid', 'flowchart LR\n A[Input] --> B[Output]'],
    ['svg', '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10"/></svg>'],
    ['dot', 'digraph { a [label="Input"]; a -> b }'],
  ])('defers %s source until selection, then highlights without viewport delivery', async (lang, code) => {
    const preview = {
      render: async () => 'data:image/svg+xml,%3Csvg%2F%3E',
      labels: { source: 'Source', preview: 'Preview', diagram: 'Diagram', error: 'Error', zoom: 'Zoom', pending: 'Pending', close: 'Close', interaction: 'Pan and zoom' },
    }
    const view = render(<CodeBlock code={code} lang={lang} preview={preview} {...markdownLabels.code} />)
    expect(view.container.querySelector('pre')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    await waitFor(() => { expect(view.container.querySelector('pre.shiki')).not.toBeNull() })
    expect(view.container.querySelector('[data-code-block-source-view]')?.hasAttribute('aria-hidden')).toBe(false)
    expect(view.container.querySelector('pre code')?.textContent).toBe(code)
    expect(view.container.querySelectorAll('pre span[style]').length).toBeGreaterThan(1)
  })

  it('does not observe an unsupported language', () => {
    const view = render(
      <CodeBlock code="IDENTIFICATION DIVISION." lang="cobol" {...markdownLabels.code} />,
    )
    expect(view.container.querySelector('pre.shiki')).toBeNull()
    expect(IntersectionObserverStub.instances).toHaveLength(0)
  })

  it('releases the offscreen observer when preview replaces source, then highlights on selection', async () => {
    const code = '<svg><rect width="10"/></svg>'
    const props = { code, lang: 'svg', ...markdownLabels.code }
    const view = render(<CodeBlock {...props} />)
    const block = view.container.querySelector('.md-code-block')!
    const observer = IntersectionObserverStub.instances[0]!
    expect(observer.observed.has(block)).toBe(true)
    expect(block.querySelector('pre.shiki')).toBeNull()

    const preview = {
      render: async () => 'data:image/svg+xml,%3Csvg%2F%3E',
      labels: { source: 'Source', preview: 'Preview', diagram: 'Diagram', error: 'Error', zoom: 'Zoom', pending: 'Pending', close: 'Close', interaction: 'Pan and zoom' },
    }
    view.rerender(<CodeBlock {...props} preview={preview} />)
    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    await waitFor(() => { expect(block.querySelector('pre.shiki')).not.toBeNull() })
    const highlighted = block.querySelector('pre.shiki')!
    expect(highlighted.textContent).toBe(code)
    expect(observer.unobserved.has(block)).toBe(true)
    expect(observer.disconnected).toBe(true)

    view.rerender(<CodeBlock {...props} />)
    expect(block.querySelector('pre.shiki')).toBe(highlighted)
    expect(IntersectionObserverStub.instances.every(instance => instance.disconnected)).toBe(true)
  })

  it('releases the shared observer when the last pending block unmounts', () => {
    const view = render(<CodeBlock code="const pending = true" lang="ts" {...markdownLabels.code} />)
    const block = view.container.querySelector('.md-code-block')!
    const observer = IntersectionObserverStub.instances[0]!

    view.unmount()

    expect(observer.unobserved.has(block)).toBe(true)
    expect(observer.disconnected).toBe(true)
  })

  it('highlights immediately when IntersectionObserver is unavailable', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const view = render(<CodeBlock code="const fallback = true" lang="ts" {...markdownLabels.code} />)
    expect(view.container.querySelector('pre.shiki')).not.toBeNull()
  })

  it('keeps an intersecting streaming block plain until its lazy grammar loads', async () => {
    const view = render(
      <CodeBlock code="print(1)" lang="python" streaming {...markdownLabels.code} />,
    )
    const block = view.container.querySelector('.md-code-block')!
    const observer = IntersectionObserverStub.instances[0]!

    act(() => { observer.intersect(block, true) })
    expect(block.querySelector('pre.shiki')).toBeNull()

    await waitFor(() => { expect(block.querySelector('pre.shiki')).not.toBeNull() }, { timeout: 5_000 })
  })

  it('keeps a read card plain until that card intersects', async () => {
    const view = render(
      <ReadBlock
        label="data.json"
        lang="json"
        lines={[{ number: 1, text: '{"ready":true}' }]}
        totalLines={1}
        labels={readBlockLabels}
      />,
    )
    const block = view.container.querySelector('[data-read]')!
    expect(block.querySelectorAll('[class^="_content_"] span')).toHaveLength(0)
    const observer = IntersectionObserverStub.instances[0]!

    act(() => { observer.intersect(block, true) })
    await waitFor(() => {
      expect(block.querySelectorAll('[class^="_content_"] span[style]').length).toBeGreaterThan(1)
    })
  })
})


describe('viewport-activated diagram previews', () => {
  const labels = { diagram: 'Diagram', error: 'Error', zoom: 'Zoom', pending: 'Pending', close: 'Close', interaction: 'Pan and zoom' }
  const imageUrl = 'data:image/svg+xml,%3Csvg%2F%3E'

  it('leaves an offscreen history unrendered and activates only visible previews', async () => {
    const renderer = vi.fn(async () => imageUrl)
    const view = render(<>{Array.from({ length: 20 }, (_, index) =>
      <SourcePreview key={index} code={String(index)} render={renderer} labels={labels} />)}</>)
    expect(renderer).not.toHaveBeenCalled()
    expect(view.container.querySelectorAll('img')).toHaveLength(0)
    expect(IntersectionObserverStub.instances).toHaveLength(1)
    const observer = IntersectionObserverStub.instances[0]!
    expect(observer.observed.size).toBe(20)
    const target = [...observer.observed][19]!
    await act(async () => { observer.intersect(target, true) })
    expect(renderer).toHaveBeenCalledExactlyOnceWith('19', expect.any(AbortSignal))
    fireEvent.load(view.container.querySelector('img')!)
    const image = screen.getByRole('img')
    await act(async () => { observer.intersect(target, false) })
    await act(async () => { observer.intersect(target, true) })
    expect(renderer).toHaveBeenCalledOnce()
    expect(screen.getByRole('img')).toBe(image)
    view.unmount()
    expect(observer.observed.size).toBe(0)
    expect(observer.disconnected).toBe(true)
  })

  it('cancels work leaving the viewport and ignores its completion after reentry', async () => {
    const first = Promise.withResolvers<string>()
    const renderer = vi.fn((_code: string, _signal: AbortSignal) => first.promise).mockResolvedValueOnce(imageUrl)
    const view = render(<SourcePreview code="first" render={renderer} labels={labels} />)
    const observer = IntersectionObserverStub.instances[0]!
    const target = [...observer.observed][0]!
    await act(async () => { observer.intersect(target, true) })
    fireEvent.load(view.container.querySelector('img')!)
    await act(async () => { observer.intersect(target, false) })
    view.rerender(<SourcePreview code="second" render={renderer} labels={labels} />)
    expect(renderer).toHaveBeenCalledOnce()
    await act(async () => { observer.intersect(target, true) })
    const signal = renderer.mock.calls[1]![1]
    await act(async () => { observer.intersect(target, false) })
    expect(signal.aborted).toBe(true)
    renderer.mockResolvedValueOnce(imageUrl)
    await act(async () => { observer.intersect(target, true) })
    fireEvent.load(view.container.querySelector('img')!)
    await act(async () => { first.resolve('obsolete') })
    expect(screen.getByRole('img').getAttribute('src')).toBe(imageUrl)
    expect(renderer).toHaveBeenCalledTimes(3)
  })

  it('keeps an offscreen lightbox active and cancels its unfinished refresh on close', async () => {
    const replacement = Promise.withResolvers<string>()
    const renderer = vi.fn((_code: string, _signal: AbortSignal) => replacement.promise).mockResolvedValueOnce(imageUrl)
    const actions = document.createElement('div')
    document.body.append(actions)
    const previous = document.documentElement.style.colorScheme
    const view = render(<SourcePreview code="diagram" render={renderer} labels={labels} actions={actions} />)
    try {
      const observer = IntersectionObserverStub.instances[0]!
      const target = [...observer.observed][0]!
      await act(async () => { observer.intersect(target, true) })
      fireEvent.load(view.container.querySelector('img')!)
      fireEvent.click(screen.getByRole('button', { name: labels.zoom }))
      await act(async () => { observer.intersect(target, false) })
      await act(async () => { document.documentElement.style.colorScheme = 'dark' })
      expect(renderer).toHaveBeenCalledTimes(2)
      const signal = renderer.mock.calls[1]![1]
      expect(signal.aborted).toBe(false)
      expect(screen.getByRole('dialog')).toBeDefined()
      fireEvent.click(screen.getByRole('button', { name: labels.close }))
      expect(signal.aborted).toBe(true)
      await act(async () => { replacement.reject(new Error('cancelled')) })
      expect(screen.queryByRole('status')).toBeNull()
      expect(screen.getByRole('img').getAttribute('src')).toBe(imageUrl)
    } finally {
      view.unmount()
      actions.remove()
      document.documentElement.style.colorScheme = previous
    }
  })

  it('defers offscreen theme updates and retains the loaded image until reentry refresh loads', async () => {
    const renderer = vi.fn(async () => imageUrl)
    const previous = document.documentElement.style.colorScheme
    const view = render(<SourcePreview code="diagram" render={renderer} labels={labels} />)
    try {
      const observer = IntersectionObserverStub.instances[0]!
      const target = [...observer.observed][0]!
      await act(async () => { observer.intersect(target, true) })
      fireEvent.load(view.container.querySelector('img')!)
      const image = screen.getByRole('img')
      await act(async () => { observer.intersect(target, false) })
      await act(async () => { document.documentElement.style.colorScheme = 'dark' })
      expect(renderer).toHaveBeenCalledOnce()
      expect(screen.getByRole('img')).toBe(image)
      renderer.mockResolvedValueOnce('data:image/svg+xml,new')
      await act(async () => { observer.intersect(target, true) })
      expect(renderer).toHaveBeenCalledTimes(2)
      expect(screen.getByRole('img')).toBe(image)
      expect(screen.queryByRole('status')).toBeNull()
      fireEvent.load(view.container.querySelector('img[src="data:image/svg+xml,new"]')!)
      expect(screen.getByRole('img').getAttribute('src')).toBe('data:image/svg+xml,new')
    } finally {
      view.unmount()
      document.documentElement.style.colorScheme = previous
    }
  })
})
