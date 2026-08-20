import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { DeepSeekFileStore } from '../src/file-store.ts'
import { DeepSeekUploadIndex } from '../src/upload-index.ts'

const REF: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: 3,
  width: 1,
  height: 1,
}
const VERSION: RequestImageAttachment = {
  variantId: ImageVariantId(`sha256:${'b'.repeat(64)}`),
  master: REF,
  data: Uint8Array.of(1, 2, 3),
  mediaType: 'image/png',
  bytes: 3,
  width: 1,
  height: 1,
  depth: 'uchar',
  space: 'srgb',
  hasAlpha: true,
}
const CONNECTION = { baseURL: 'https://api.deepseek.com', apiKey: 'key' }
const POLICY = { expiresAfterSeconds: 604_800, refreshMarginSeconds: 3_600, quotaCleanupBatch: 100 }
const NOW = 1_700_000_000_000

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

function uploadFetch(now: () => number = () => NOW) {
  let uploads = 0
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'POST') {
      uploads += 1
      const createdAt = now() / 1_000
      return new Response(JSON.stringify({
        id: `file-api-${uploads}`,
        object: 'file',
        bytes: 3,
        created_at: createdAt,
        filename: `dsh-${'a'.repeat(16)}-${'b'.repeat(8)}.png`,
        purpose: 'user_data',
        expires_at: createdAt + POLICY.expiresAfterSeconds,
      }), { status: 200 })
    }
    if (init?.method === 'DELETE') {
      const id = requestUrl(_url).split('/').at(-1)
      return new Response(JSON.stringify({ id, object: 'file', deleted: true }), { status: 200 })
    }
    throw new Error('unexpected Files API request')
  }) as typeof fetch
  return { fetchImpl, uploads: () => uploads }
}

describe('DeepSeekFileStore', () => {
  it('singleflights the first upload and reuses the durable mapping across store instances', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-file-store-'))
    const index = new DeepSeekUploadIndex(join(dir, 'index.json'))
    const remote = uploadFetch()
    const first = new DeepSeekFileStore({ index, now: () => NOW, fetch: remote.fetchImpl })

    const [a, b] = await Promise.all([
      first.ensureUploaded(VERSION, CONNECTION, POLICY),
      first.ensureUploaded(VERSION, CONNECTION, POLICY),
    ])
    expect(a.record.fileId).toBe('file-api-1')
    expect(b.record.fileId).toBe('file-api-1')
    expect(remote.uploads()).toBe(1)

    const resumed = new DeepSeekFileStore({ index, now: () => NOW, fetch: remote.fetchImpl })
    await expect(resumed.ensureUploaded(VERSION, CONNECTION, POLICY))
      .resolves.toMatchObject({ record: { fileId: 'file-api-1' }, uploaded: false })
    expect(remote.uploads()).toBe(1)
  })

  it('keeps a shared upload alive while another waiter remains', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-file-store-'))
    const index = new DeepSeekUploadIndex(join(dir, 'index.json'))
    let complete: ((response: Response) => void) | undefined
    let uploadSignal: AbortSignal | undefined
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      uploadSignal = init?.signal ?? undefined
      return new Promise<Response>((resolve, reject) => {
        complete = resolve
        uploadSignal?.addEventListener('abort', () => reject(uploadSignal?.reason), { once: true })
      })
    }) as typeof fetch
    const store = new DeepSeekFileStore({ index, now: () => NOW, fetch: fetchImpl })
    const controller = new AbortController()

    const cancelled = store.ensureUploaded(VERSION, CONNECTION, POLICY, controller.signal)
    const completed = store.ensureUploaded(VERSION, CONNECTION, POLICY)
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
    const reason = new Error('cancel one upload waiter')
    controller.abort(reason)

    await expect(cancelled).rejects.toBe(reason)
    expect(uploadSignal?.aborted).toBe(false)
    complete?.(new Response(JSON.stringify({
      id: 'file-api-shared',
      object: 'file',
      bytes: 3,
      created_at: NOW / 1_000,
      filename: `dsh-${'a'.repeat(16)}-${'b'.repeat(8)}.png`,
      purpose: 'user_data',
      expires_at: NOW / 1_000 + POLICY.expiresAfterSeconds,
    }), { status: 200 }))
    await expect(completed).resolves.toMatchObject({ record: { fileId: 'file-api-shared' } })
  })

  it('aborts the shared upload after its only waiter cancels', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-file-store-'))
    const index = new DeepSeekUploadIndex(join(dir, 'index.json'))
    let uploadSignal: AbortSignal | undefined
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      uploadSignal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        uploadSignal?.addEventListener('abort', () => reject(uploadSignal?.reason), { once: true })
      })
    }) as typeof fetch
    const store = new DeepSeekFileStore({ index, now: () => NOW, fetch: fetchImpl })
    const controller = new AbortController()
    const upload = store.ensureUploaded(VERSION, CONNECTION, POLICY, controller.signal)
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))

    const reason = new Error('cancel only upload waiter')
    controller.abort(reason)

    await expect(upload).rejects.toBe(reason)
    expect(uploadSignal?.reason).toBe(reason)
  })

  it('does not persist an upload whose response is missing and retries on the next request', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-file-store-'))
    const index = new DeepSeekUploadIndex(join(dir, 'index.json'))
    const good = uploadFetch()
    let first = true
    const fetchImpl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      if (first) {
        first = false
        return Promise.resolve(new Response('', { status: 204 }))
      }
      return good.fetchImpl(url, init)
    }) as typeof fetch
    const store = new DeepSeekFileStore({ index, now: () => NOW, fetch: fetchImpl })

    await expect(store.ensureUploaded(VERSION, CONNECTION, POLICY))
      .rejects.toBeInstanceOf(Error)
    await expect(store.ensureUploaded(VERSION, CONNECTION, POLICY))
      .resolves.toMatchObject({ record: { fileId: 'file-api-1' }, uploaded: true })
  })

  it('reuses local expires_at above the refresh margin and uploads again at the margin', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-file-store-'))
    const index = new DeepSeekUploadIndex(join(dir, 'index.json'))
    let now = NOW
    const remote = uploadFetch(() => now)
    const store = new DeepSeekFileStore({ index, now: () => now, fetch: remote.fetchImpl })

    await expect(store.ensureUploaded(VERSION, CONNECTION, POLICY))
      .resolves.toMatchObject({ record: { fileId: 'file-api-1' }, uploaded: true })
    now = NOW + (POLICY.expiresAfterSeconds - POLICY.refreshMarginSeconds) * 1_000 - 1
    await expect(store.ensureUploaded(VERSION, CONNECTION, POLICY))
      .resolves.toMatchObject({ record: { fileId: 'file-api-1' }, uploaded: false })
    now += 1
    await expect(store.ensureUploaded(VERSION, CONNECTION, POLICY))
      .resolves.toMatchObject({ record: { fileId: 'file-api-2' }, uploaded: true })

    expect(remote.uploads()).toBe(2)
    expect(vi.mocked(remote.fetchImpl).mock.calls.every(([, init]) => init?.method === 'POST')).toBe(true)
  })

  it('releases an indexed file through DELETE and removes only that mapping', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-file-store-'))
    const index = new DeepSeekUploadIndex(join(dir, 'index.json'))
    const remote = uploadFetch()
    const store = new DeepSeekFileStore({ index, now: () => NOW, fetch: remote.fetchImpl })
    await store.ensureUploaded(VERSION, CONNECTION, POLICY)

    await expect(store.release(VERSION, CONNECTION, POLICY)).resolves.toBe(true)
    await expect(store.release(VERSION, CONNECTION, POLICY)).resolves.toBe(false)
    expect(remote.fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('finishes pagination before deleting cursor files during quota recovery', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-file-store-'))
    const deleted = new Set<string>()
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const target = new URL(requestUrl(input))
      if (init?.method === 'DELETE') {
        const id = target.pathname.split('/').at(-1) ?? ''
        deleted.add(id)
        return new Response(JSON.stringify({ id, object: 'file', deleted: true }), { status: 200 })
      }
      const after = target.searchParams.get('after')
      if (after !== null && deleted.has(after)) throw new Error('deleted cursor cannot be reused')
      const id = after === null ? 'file-api-oldest' : 'file-api-next'
      return new Response(JSON.stringify({
        object: 'list',
        data: [{
          id,
          object: 'file',
          bytes: 3,
          created_at: NOW / 1_000,
          filename: `dsh-${id}.png`,
          purpose: 'user_data',
        }],
        first_id: id,
        last_id: id,
        has_more: after === null,
      }), { status: 200 })
    }) as typeof fetch
    const store = new DeepSeekFileStore({
      index: new DeepSeekUploadIndex(join(dir, 'index.json')),
      now: () => NOW,
      fetch: fetchImpl,
    })

    await expect(store.reclaimOldestOwned(CONNECTION, 2)).resolves.toBe(2)
    expect([...deleted]).toEqual(['file-api-oldest', 'file-api-next'])
  })
})
