// @vitest-environment jsdom
/** Static dependency discovery has an injected file reader and never exposes it to the iframe. */
import { describe, expect, it, vi } from 'vitest'
import { packHtml } from '../src/client/html/pack.ts'
import type { HtmlPackLimits, ReadHtmlRelative } from '../src/client/html/pack.ts'
import type { DocumentFileBytes } from '../src/client/rpc.ts'

const limits: HtmlPackLimits = { maxAssetBytes: 1024, maxTotalBytes: 16 * 1024, maxAssets: 8 }
const source = '<link rel="stylesheet" href="./main.css"><script src="./main.js"></script>'

const utf8 = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text)
const file = (data: Uint8Array<ArrayBuffer>): DocumentFileBytes => ({
  absolutePath: '/workspace/asset', version: 'v1', offset: 0, data, bytes: data.byteLength, eof: true,
})

describe('packHtml', () => {
  it('collects direct classic JS and CSS in document order and deduplicates repeated references', async () => {
    const read = vi.fn<ReadHtmlRelative>().mockResolvedValue(file(utf8('/* 你好 */')))
    const signal = new AbortController().signal
    const bundle = await packHtml(utf8(source + '<script defer src="./main.js"></script>'), read, limits, signal)
    expect(read.mock.calls).toEqual([['./main.css', signal], ['./main.js', signal]])
    expect(bundle.assets.map(asset => [asset.kind, asset.reference])).toEqual([['stylesheet', './main.css'], ['script', './main.js']])
    expect(document.querySelector('script,link')).toBeNull()
  })

  it('leaves HTTPS, module, file, root-relative, data and runtime dependencies to browser rules', async () => {
    const read = vi.fn<ReadHtmlRelative>()
    const html = '<script src="https://example.invalid/a.js"></script><script src="//example.invalid/a.js"></script><script type="module" src="./module.js"></script><script type="application/ld+json" src="./data.js"></script><script src="file:///a.js"></script><script src="/a.js"></script><script src="data:text/javascript,1"></script><script>fetch("./data.json")</script><link rel="icon" href="./icon.css"><!-- <script src="./comment.js"></script> -->'
    expect((await packHtml(utf8(html), read, limits, new AbortController().signal)).assets).toEqual([])
    expect(read).not.toHaveBeenCalled()
  })

  it('does not turn base-relative browser resources into local file reads', async () => {
    const read = vi.fn<ReadHtmlRelative>()
    for (const base of ['https://example.invalid/assets/', './assets/', 'file:///assets/']) {
      const bundle = await packHtml(utf8(`<base href="${base}">${source}`), read, limits, new AbortController().signal)
      expect(bundle.assets).toEqual([])
    }
    expect(read).not.toHaveBeenCalled()
  })

  it('does not read a link without a stylesheet relationship', async () => {
    const read = vi.fn<ReadHtmlRelative>()
    const bundle = await packHtml(utf8('<link href="./main.css">'), read, limits, new AbortController().signal)
    expect(bundle.assets).toEqual([])
    expect(read).not.toHaveBeenCalled()
  })

  it('passes decoded HTML attributes to the scoped reader without recursing into CSS imports', async () => {
    const read = vi.fn<ReadHtmlRelative>().mockResolvedValue(file(utf8('@import "./child.css";a{background:url(./image.png)}')))
    const bundle = await packHtml(utf8('<link rel="STYLESHEET" href="main.css?v=1&amp;x=2">'), read, limits, new AbortController().signal)
    expect(read.mock.calls[0]?.[0]).toBe('main.css?v=1&x=2')
    expect(read).toHaveBeenCalledOnce()
    expect(bundle.assets).toHaveLength(1)
  })

  it('accepts exact decoded limits and rejects oversized root, asset, aggregate and count', async () => {
    const html = '<script src="a.js"></script>'
    const data = utf8(html)
    const size = new TextEncoder().encode(html).length
    const read = vi.fn<ReadHtmlRelative>().mockResolvedValue(file(utf8('雪')))
    const signal = new AbortController().signal
    await expect(packHtml(data, read, { maxAssetBytes: 3, maxTotalBytes: size + 3, maxAssets: 1 }, signal)).resolves.toMatchObject({ data })
    await expect(packHtml(data, read, { ...limits, maxTotalBytes: size - 1 }, signal)).rejects.toThrow('total byte limit')
    await expect(packHtml(data, read, { ...limits, maxAssetBytes: 2 }, signal)).rejects.toThrow('asset exceeds')
    await expect(packHtml(data, read, { ...limits, maxTotalBytes: size + 2 }, signal)).rejects.toThrow('total byte limit')
    await expect(packHtml(data, read, { ...limits, maxAssets: 0 }, signal)).rejects.toThrow('asset count limit')
  })

  it('propagates read errors and rejects malformed resource text instead of returning a partial package', async () => {
    const read = vi.fn<ReadHtmlRelative>().mockRejectedValue(new Error('outside workspace'))
    await expect(packHtml(utf8(source), read, limits, new AbortController().signal)).rejects.toThrow('outside workspace')
    read.mockResolvedValue(file(new Uint8Array([255])))
    await expect(packHtml(utf8(source), read, limits, new AbortController().signal)).rejects.toThrow()
  })

  it('does not read after abort and discards a read that settles after cancellation', async () => {
    const pending = Promise.withResolvers<DocumentFileBytes>()
    const read = vi.fn<ReadHtmlRelative>().mockReturnValue(pending.promise)
    const controller = new AbortController()
    const packing = packHtml(utf8(source), read, limits, controller.signal)
    expect(read).toHaveBeenCalledOnce()
    const rejected = expect(packing).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    pending.resolve(file(utf8('body{}')))
    await rejected
    await expect(packHtml(utf8(source), read, limits, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(read).toHaveBeenCalledOnce()
  })
})
