/** Preparation publishes verified assets and joins failed or cancelled installer processes. */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { downloadAsset } from '../src/runtime.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.unstubAllGlobals(); for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-speech-runtime-'))
  cleanup.push(async () => { await rm(root, { recursive: true, force: true }) })
  return root
}
const bytes = Buffer.from('verified model')
const asset = { name: 'model.bin', url: 'https://example.invalid/model', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
const signal = (): AbortSignal => new AbortController().signal

it('publishes verified files, reuses them offline, and replaces corrupted cached files', async () => {
  const root = await fixture(), fetcher = vi.fn(async () => new Response(bytes))
  vi.stubGlobal('fetch', fetcher)
  const path = await downloadAsset(asset, root, signal())
  expect(await readFile(path)).toEqual(bytes)
  await downloadAsset(asset, root, signal())
  expect(fetcher).toHaveBeenCalledOnce()
  await writeFile(path, 'corrupt')
  await downloadAsset(asset, root, signal())
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(await readdir(root)).toEqual(['model.bin'])
})

it('rejects altered downloads and HTTP failures without leaving partial files', async () => {
  const root = await fixture()
  vi.stubGlobal('fetch', async () => new Response('corrupt'))
  await expect(downloadAsset(asset, root, signal())).rejects.toThrow('checksum')
  vi.stubGlobal('fetch', async () => new Response(bytes))
  await expect(downloadAsset({ ...asset, sha256: 'bad-digest' }, root, signal())).rejects.toThrow('checksum')
  await expect(downloadAsset({ ...asset, bytes: 1 }, root, signal())).rejects.toThrow('pinned size')
  vi.stubGlobal('fetch', async () => new Response(null, { status: 503 }))
  await expect(downloadAsset(asset, root, signal())).rejects.toThrow('503')
  vi.stubGlobal('fetch', async () => new Response(null, { status: 200 }))
  await expect(downloadAsset(asset, root, signal())).rejects.toThrow('200')
  expect(await readdir(root)).toEqual([])
})

it('cancels streaming downloads and refuses invalid cache locations', async () => {
  const root = await fixture(), cancel = new AbortController(), reading = Promise.withResolvers<undefined>()
  vi.stubGlobal('fetch', async () => new Response(new ReadableStream({
    start(controller) { cancel.signal.addEventListener('abort', () => { controller.error(cancel.signal.reason) }, { once: true }) },
    pull() { reading.resolve(undefined) },
  })))
  const pending = downloadAsset(asset, root, cancel.signal)
  const rejected = expect(pending).rejects.toThrow()
  await reading.promise; cancel.abort()
  await rejected
  expect(await readdir(root)).toEqual([])
  await expect(downloadAsset(asset, root, cancel.signal)).rejects.toThrow()
  const child = join(root, 'invalid')
  await writeFile(child, 'file')
  await expect(downloadAsset(asset, child, signal())).rejects.toThrow()
})
