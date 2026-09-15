// @vitest-environment jsdom
/** Browser-action feedback and route-owned asynchronous clipboard work. */
import assert from 'node:assert/strict'
import { createApp, h, nextTick, reactive, ref, type App, type Slots } from 'vue'
import { fireEvent, getByRole, queryByRole, waitFor } from '@testing-library/dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Theme from '../.vitepress/theme/index.ts'

vi.mock('vitepress', () => ({ useData: () => data, useRoute: () => route }))
vi.mock('vitepress/theme', () => ({ default: { Layout: {
  setup: (_props: unknown, { slots }: { slots: Slots }) => () => h('main', null, slots['doc-before']?.()),
} } }))
vi.mock('../.vitepress/theme/mermaid-viewer.ts', () => ({ installMermaidViewer: () => ({ refresh() {}, dispose() {} }) }))

const data = {
  lang: ref('en-US'), isDark: ref(false),
  frontmatter: ref<Record<string, unknown>>({}),
  site: ref({ base: '/' }), page: ref({ isNotFound: false }),
}
const route = reactive({ path: '/en/guide/quickstart' })
const fetchMock = vi.fn<typeof fetch>()
const write = vi.fn<(items: ClipboardItem[]) => Promise<void>>()
let app: App | undefined
let host: HTMLDivElement
let copied: Blob | undefined
let activeWrite: Promise<void> | undefined
const deferredWork: { promise: Promise<unknown>; reject: (reason: unknown) => void }[] = []

class TestClipboardItem {
  constructor(readonly data: Record<string, Promise<Blob>>) {}
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  deferredWork.push({ promise, reject })
  void promise.catch((_error: unknown) => {
    // Teardown can reject a barrier before an assertion reaches its consumer.
  })
  return { promise, resolve, reject }
}

function response(text = '# Quickstart\n\n[Reference](../reference/index.md)\n', status = 200, type = 'text/markdown') {
  return new Response(text, { status, headers: { 'content-type': `${type}; charset=utf-8` } })
}

function mount() {
  app = createApp(Theme.Layout)
  app.mount(host)
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  data.lang.value = 'en-US'
  data.site.value = { base: '/' }
  data.frontmatter.value = { rawMarkdownPath: 'en/guide/quickstart.md' }
  data.page.value = { isNotFound: false }
  route.path = '/en/guide/quickstart'
  copied = undefined
  activeWrite = undefined
  fetchMock.mockReset().mockResolvedValue(response())
  write.mockReset().mockImplementation((items) => {
    const item = items[0] as unknown as TestClipboardItem
    const content = item.data['text/plain']
    assert(content !== undefined)
    activeWrite = content.then((blob) => { copied = blob })
    return activeWrite
  })
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('ClipboardItem', TestClipboardItem)
  vi.stubGlobal('navigator', { clipboard: { write } })
})

afterEach(async () => {
  app?.unmount()
  app = undefined
  const work = deferredWork.splice(0)
  for (const pending of work) pending.reject(new Error('Test disposed'))
  await Promise.allSettled([...work.map(pending => pending.promise), activeWrite])
  host.remove()
  vi.unstubAllGlobals()
})

describe('page Markdown actions', () => {
  it.each(['en-US', 'zh-CN'])('preserves the accessible controls and status in %s', async (lang) => {
    data.lang.value = lang
    data.frontmatter.value = { rawMarkdownPath: `${lang === 'en-US' ? 'en/' : ''}guide/quickstart.md` }
    mount()
    await expect(`${host.innerHTML}\n`).toMatchFileSnapshot(`./expected/page-markdown-actions.${lang}.html`)
  })

  it.each(['/', '/deepseek-harness/'])('uses the manifest index route under base %s, independent of the visible URL', (base) => {
    data.site.value = { base }
    data.frontmatter.value = { rawMarkdownPath: 'en/reference/index.md' }
    route.path = `${base}en/reference/index.html?from=nav#api`
    mount()
    const link = getByRole(host, 'link', { name: 'View Markdown (opens in a new tab)' })
    expect(link.getAttribute('href')).toBe(`${base}en/reference/index.md`)
    expect(link.getAttribute('target')).toBe('_blank')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['home', '404'])('omits actions on %s', (kind) => {
    if (kind === 'home') data.frontmatter.value = { layout: false }
    else data.page.value = { isNotFound: true }
    mount()
    expect(queryByRole(host, 'button')).toBeNull()
    expect(queryByRole(host, 'link')).toBeNull()
  })

  it('starts clipboard.write during the click and copies the fetched plain text before reporting success', async () => {
    const pending = deferred<Response>()
    fetchMock.mockReturnValue(pending.promise)
    mount()
    const button = getByRole(host, 'button', { name: 'Copy Markdown' })
    fireEvent.click(button)
    expect(write).toHaveBeenCalledOnce()
    expect(copied).toBeUndefined()
    fireEvent.click(button)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/en/guide/quickstart.md?dsh-raw=1')
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
    await nextTick()
    expect(button).toHaveProperty('disabled', true)
    expect(getByRole(host, 'status').textContent).toBe('Copying…')
    pending.resolve(response())
    await waitFor(() => { expect(getByRole(host, 'status').textContent).toBe('Markdown copied.') })
    expect(copied?.type).toBe('text/plain')
    const reader = new FileReader()
    const text = new Promise((resolve) => { reader.addEventListener('load', () => { resolve(reader.result) }, { once: true }) })
    assert(copied !== undefined)
    reader.readAsText(copied)
    expect(await text).toBe('# Quickstart\n\n[Reference](../reference/index.md)\n')
    expect(button).toHaveProperty('disabled', false)
  })

  it.each(['network', '404', 'html'])('reports a %s response failure without success and allows retry', async (failure) => {
    if (failure === 'network') fetchMock.mockRejectedValueOnce(new Error('offline'))
    else fetchMock.mockResolvedValueOnce(response('not Markdown', failure === '404' ? 404 : 200, failure === 'html' ? 'text/html' : 'text/markdown'))
    mount()
    fireEvent.click(getByRole(host, 'button'))
    await waitFor(() => { expect(getByRole(host, 'status').textContent).toContain('Could not load Markdown.') })
    expect(copied).toBeUndefined()
    fireEvent.click(getByRole(host, 'button'))
    await waitFor(() => { expect(getByRole(host, 'status').textContent).toBe('Markdown copied.') })
  })

  it('accepts static hosting that serves Markdown as plain text', async () => {
    fetchMock.mockResolvedValueOnce(response('# Plain text hosting\n', 200, 'text/plain'))
    mount()
    fireEvent.click(getByRole(host, 'button'))
    await waitFor(() => { expect(getByRole(host, 'status').textContent).toBe('Markdown copied.') })
  })

  it('reports failure when reading the response body rejects', async () => {
    const raw = response()
    vi.spyOn(raw, 'text').mockRejectedValueOnce(new Error('Connection closed'))
    fetchMock.mockResolvedValueOnce(raw)
    mount()
    fireEvent.click(getByRole(host, 'button'))
    await waitFor(() => { expect(getByRole(host, 'status').textContent).toContain('Could not load Markdown.') })
    expect(copied).toBeUndefined()
  })

  it('ignores a late successful write after its page has been replaced', async () => {
    const writeDone = deferred<void>()
    write.mockImplementationOnce(() => writeDone.promise)
    mount()
    fireEvent.click(getByRole(host, 'button'))
    route.path = '/en/reference/'
    data.frontmatter.value = { rawMarkdownPath: 'en/reference/index.md' }
    await nextTick()
    writeDone.resolve()
    await writeDone.promise
    await nextTick()
    expect(getByRole(host, 'status').textContent).toBe('')
  })

  it.each(['write', 'item'])('provides manual-copy feedback when the %s API is missing', async (missing) => {
    if (missing === 'item') vi.stubGlobal('ClipboardItem', undefined)
    else vi.stubGlobal('navigator', {})
    mount()
    fireEvent.click(getByRole(host, 'button'))
    await nextTick()
    expect(getByRole(host, 'status').textContent).toContain('Could not copy.')
    expect(getByRole(host, 'link')).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('aborts an unconsumed fetch when the clipboard rejects before consuming its data', async () => {
    const pending = deferred<Response>()
    fetchMock.mockReturnValue(pending.promise)
    write.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'))
    mount()
    fireEvent.click(getByRole(host, 'button'))
    await waitFor(() => { expect(getByRole(host, 'status').textContent).toContain('Could not copy.') })
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    pending.reject(new DOMException('Aborted', 'AbortError'))
    await pending.promise.catch((error: unknown) => { void error })
    await nextTick()
    expect(getByRole(host, 'status').textContent).toContain('Could not copy.')
  })

  it.each(['route', 'locale', 'unmount'])('cancels old data and ignores its completion after %s changes', async (change) => {
    const pending = deferred<Response>()
    fetchMock.mockReturnValueOnce(pending.promise)
    mount()
    fireEvent.click(getByRole(host, 'button'))
    const oldWrite = activeWrite
    assert(oldWrite !== undefined)
    const signal = fetchMock.mock.calls[0]?.[1]?.signal
    if (change === 'unmount') { app?.unmount(); app = undefined }
    else {
      route.path = change === 'route' ? '/en/reference/' : '/guide/quickstart'
      data.lang.value = change === 'route' ? 'en-US' : 'zh-CN'
      data.frontmatter.value = { rawMarkdownPath: change === 'route' ? 'en/reference/index.md' : 'guide/quickstart.md' }
    }
    await nextTick()
    expect(signal?.aborted).toBe(true)
    pending.resolve(response('# Old page\n'))
    await expect(oldWrite).rejects.toThrow()
    await nextTick()
    expect(copied).toBeUndefined()
    if (change === 'unmount') expect(host.textContent).toBe('')
    else {
      expect(getByRole(host, 'status').textContent).toBe('')
      fireEvent.click(getByRole(host, 'button', { name: change === 'route' ? 'Copy Markdown' : '复制 Markdown' }))
      await waitFor(() => { expect(getByRole(host, 'status').textContent).toBe(change === 'route' ? 'Markdown copied.' : '已复制 Markdown。') })
      expect(fetchMock.mock.calls[1]?.[0]).toBe(change === 'route' ? '/en/reference/index.md?dsh-raw=1' : '/guide/quickstart.md?dsh-raw=1')
    }
  })
})
