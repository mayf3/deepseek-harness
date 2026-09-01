import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  backgroundUploadWorker, createBackgroundUploadTransport,
} from '../src/client/background-upload.ts'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('background upload worker body', () => {
  it('sends the Blob with credentials and reports progress, completion, and failure', () => {
    const posted: unknown[] = []
    const scope: {
      onmessage: ((event: MessageEvent<{
        url: string
        body: Blob
        headers: Readonly<Record<string, string>>
      }>) => void) | null
      postMessage(message: unknown): void
    } = { onmessage: null, postMessage: (message: unknown) => { posted.push(message) } }
    const xhr: {
      upload: { onprogress: ((event: ProgressEvent) => void) | null }
      status: number
      responseText: string
      withCredentials: boolean
      onload: ((event: ProgressEvent) => void) | null
      onerror: ((event: ProgressEvent) => void) | null
      open: ReturnType<typeof vi.fn>
      setRequestHeader: ReturnType<typeof vi.fn>
      send: ReturnType<typeof vi.fn>
    } = {
      upload: { onprogress: null },
      status: 201,
      responseText: '{"ok":true}',
      withCredentials: false,
      onload: null,
      onerror: null,
      open: vi.fn(),
      setRequestHeader: vi.fn(),
      send: vi.fn(),
    }
    backgroundUploadWorker(scope, () => xhr as never)
    const body = new Blob(['large'])
    scope.onmessage?.({
      data: { url: 'https://harness.test/upload', body, headers: { 'content-type': 'application/octet-stream' } },
    } as never)
    expect(xhr.open).toHaveBeenCalledWith('POST', 'https://harness.test/upload')
    expect(xhr.withCredentials).toBe(true)
    expect(xhr.setRequestHeader).toHaveBeenCalledWith('content-type', 'application/octet-stream')
    expect(xhr.send).toHaveBeenCalledWith(body)

    xhr.upload.onprogress?.({ loaded: 2, total: 4, lengthComputable: true } as ProgressEvent)
    xhr.upload.onprogress?.({ loaded: 3, total: 0, lengthComputable: false } as ProgressEvent)
    xhr.onload?.({} as ProgressEvent)
    xhr.onerror?.({} as ProgressEvent)
    expect(posted).toEqual([
      { kind: 'progress', loaded: 2, total: 4 },
      { kind: 'progress', loaded: 3 },
      { kind: 'complete', status: 201, body: '{"ok":true}' },
      { kind: 'error', message: 'background upload transport failed' },
    ])
  })

  it('uses the Worker globals when the emitted body supplies no test seams', () => {
    const posted: unknown[] = []
    const scope: {
      onmessage: ((event: MessageEvent) => void) | null
      postMessage(message: unknown): void
    } = { onmessage: null, postMessage: (message) => { posted.push(message) } }
    const xhr = {
      upload: { onprogress: null },
      status: 204,
      responseText: '',
      withCredentials: false,
      onload: null,
      onerror: null,
      open: vi.fn(),
      setRequestHeader: vi.fn(),
      send: vi.fn(),
    }
    vi.stubGlobal('self', scope)
    vi.stubGlobal('XMLHttpRequest', vi.fn(function () { return xhr }))
    backgroundUploadWorker()
    scope.onmessage?.({ data: { url: '/upload', body: new Blob(), headers: {} } } as MessageEvent)
    expect(xhr.send).toHaveBeenCalledOnce()
  })
})

describe('background upload page transport', () => {
  it('hands Blob bodies to a custom Host Worker transport without reading them', async () => {
    vi.stubGlobal('location', { origin: 'https://preview.test' })
    const body = new Blob(['opaque'])
    const fetch = vi.fn((_url: URL, _init?: RequestInit) =>
      Promise.resolve(new Response('accepted', { status: 202 })))
    const signal = new AbortController().signal
    await expect(createBackgroundUploadTransport(fetch).post({
      path: '/api/upload', body, headers: { 'x-test': 'yes' }, signal,
    })).resolves.toEqual({ status: 202, body: 'accepted' })
    expect(fetch).toHaveBeenCalledWith(new URL('https://preview.test/api/upload'), {
      method: 'POST', headers: { 'x-test': 'yes' }, body, signal,
    })

    vi.stubGlobal('location', { origin: 'null' })
    await createBackgroundUploadTransport(fetch).post({ path: '/fallback', body })
    expect(fetch.mock.calls[1]?.[0]).toEqual(new URL('http://dsh.internal/fallback'))
    expect(fetch.mock.calls[1]?.[1]).toEqual({ method: 'POST', body })
  })

  it('fails loud when a served browser has no Worker implementation', async () => {
    vi.stubGlobal('Worker', undefined)
    await expect(createBackgroundUploadTransport().post({ path: '/upload', body: new Blob() }))
      .rejects.toThrow('background upload requires Web Worker support')
  })

  it('forwards progress and completion from a dedicated Worker and then terminates it', async () => {
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:worker')
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    class FakeWorker {
      static last: FakeWorker | undefined
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: ErrorEvent) => void) | null = null
      readonly postMessage = vi.fn()
      readonly terminate = vi.fn()
      constructor(readonly url: string, readonly options: WorkerOptions) { FakeWorker.last = this }
    }
    vi.stubGlobal('Worker', FakeWorker)
    vi.stubGlobal('location', { origin: 'https://harness.test' })
    const progress = vi.fn()
    const body = new Blob(['bytes'])
    const controller = new AbortController()
    const pending = createBackgroundUploadTransport().post({
      path: '/api/upload', body, onProgress: progress, signal: controller.signal,
    })
    const worker = FakeWorker.last
    if (worker === undefined) throw new Error('worker missing')
    expect(created).toHaveBeenCalledOnce()
    expect(revoked).toHaveBeenCalledWith('blob:worker')
    expect(worker.url).toBe('blob:worker')
    expect(worker.options).toEqual({ name: 'dsh-file-upload' })
    expect(worker.postMessage).toHaveBeenCalledWith({
      url: 'https://harness.test/api/upload', body, headers: {},
    })
    worker.onmessage?.({ data: { kind: 'progress', loaded: 2 } } as MessageEvent)
    worker.onmessage?.({ data: { kind: 'progress', loaded: 4, total: 5 } } as MessageEvent)
    worker.onmessage?.({ data: { kind: 'complete', status: 200, body: 'done' } } as MessageEvent)
    worker.onmessage?.({ data: { kind: 'complete', status: 500, body: 'late' } } as MessageEvent)
    await expect(pending).resolves.toEqual({ status: 200, body: 'done' })
    controller.abort()
    expect(progress).toHaveBeenCalledWith({ loaded: 2 })
    expect(progress).toHaveBeenCalledWith({ loaded: 4, total: 5 })
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('rejects worker messages, worker errors, and caller cancellation', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:worker')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    class FakeWorker {
      static all: FakeWorker[] = []
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: ErrorEvent) => void) | null = null
      readonly postMessage = vi.fn()
      readonly terminate = vi.fn()
      constructor() { FakeWorker.all.push(this) }
    }
    vi.stubGlobal('Worker', FakeWorker)
    const transport = createBackgroundUploadTransport()

    const reported = transport.post({ path: '/upload', body: new Blob() })
    FakeWorker.all[0]?.onmessage?.({ data: { kind: 'error', message: 'network failed' } } as MessageEvent)
    await expect(reported).rejects.toThrow('network failed')

    const errored = transport.post({ path: '/upload', body: new Blob() })
    FakeWorker.all[1]?.onerror?.({ message: 'worker crashed' } as ErrorEvent)
    await expect(errored).rejects.toThrow('worker crashed')

    const unnamed = transport.post({ path: '/upload', body: new Blob() })
    FakeWorker.all[2]?.onerror?.({ message: '' } as ErrorEvent)
    await expect(unnamed).rejects.toThrow('background upload worker failed')

    const controller = new AbortController()
    const aborted = transport.post({ path: '/upload', body: new Blob(), signal: controller.signal })
    controller.abort()
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })
    expect(FakeWorker.all[3]?.terminate).toHaveBeenCalledOnce()

    const already = new AbortController()
    already.abort()
    await expect(transport.post({ path: '/upload', body: new Blob(), signal: already.signal }))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(FakeWorker.all[4]?.postMessage).not.toHaveBeenCalled()
  })
})
