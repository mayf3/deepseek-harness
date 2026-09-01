/** Background browser upload transport for large opaque request bodies. */

import type { RpcFetch } from './rpc.ts'

/** Monotone byte progress reported by a browser upload carrier. */
export interface BackgroundUploadProgress {
  readonly loaded: number
  readonly total?: number
}

/** One background upload request. */
export interface BackgroundUploadRequest {
  readonly path: string
  readonly body: Blob
  readonly headers?: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
  readonly onProgress?: (progress: BackgroundUploadProgress) => void
}

/** Small response returned after the background carrier has sent the body. */
export interface BackgroundUploadResponse {
  readonly status: number
  readonly body: string
}

/** Browser carrier that keeps file reads and network submission off the page thread. */
export interface BackgroundUploadTransport {
  /**
   * Post one Blob without materializing its bytes on the page thread.
   * @param request - target, body, cancellation, and progress observer.
   * @returns the response status and text body.
   */
  post(request: BackgroundUploadRequest): Promise<BackgroundUploadResponse>
}

interface UploadWorkerStart {
  readonly url: string
  readonly body: Blob
  readonly headers: Readonly<Record<string, string>>
}

type UploadWorkerOutput =
  | { readonly kind: 'progress'; readonly loaded: number; readonly total?: number }
  | { readonly kind: 'complete'; readonly status: number; readonly body: string }
  | { readonly kind: 'error'; readonly message: string }

interface UploadWorkerScope {
  onmessage: ((event: MessageEvent<UploadWorkerStart>) => void) | null
  postMessage(message: UploadWorkerOutput): void
}

interface UploadXhr {
  readonly upload: { onprogress: ((event: ProgressEvent) => void) | null }
  status: number
  responseText: string
  withCredentials: boolean
  onload: ((event: ProgressEvent) => void) | null
  onerror: ((event: ProgressEvent) => void) | null
  open(method: string, url: string): void
  setRequestHeader(name: string, value: string): void
  send(body: Blob): void
}

/**
 * Self-contained Worker body; its string form becomes the Blob Worker source.
 * @param scope - Worker global used for request and progress messages.
 * @param createXhr - XMLHttpRequest factory; injectable for unit coverage.
 */
export function backgroundUploadWorker(
  scope: UploadWorkerScope = self,
  createXhr: () => UploadXhr = () => new XMLHttpRequest(),
): void {
  scope.onmessage = (event: MessageEvent<UploadWorkerStart>) => {
    const request = event.data
    const xhr = createXhr()
    xhr.open('POST', request.url)
    xhr.withCredentials = true
    for (const [name, value] of Object.entries(request.headers)) xhr.setRequestHeader(name, value)
    xhr.upload.onprogress = (progress) => {
      scope.postMessage({
        kind: 'progress',
        loaded: progress.loaded,
        ...(progress.lengthComputable ? { total: progress.total } : {}),
      } satisfies UploadWorkerOutput)
    }
    xhr.onload = () => {
      scope.postMessage({ kind: 'complete', status: xhr.status, body: xhr.responseText } satisfies UploadWorkerOutput)
    }
    xhr.onerror = () => {
      scope.postMessage({ kind: 'error', message: 'background upload transport failed' } satisfies UploadWorkerOutput)
    }
    xhr.send(request.body)
  }
}

/**
 * Create a background body carrier. A custom fetch already targets a Host
 * Worker, while the served Web path creates a dedicated upload Worker.
 * @param customFetch - worker-hosted transport hook, when present.
 * @returns the selected background carrier.
 */
export function createBackgroundUploadTransport(customFetch?: RpcFetch): BackgroundUploadTransport {
  return customFetch === undefined ? workerTransport() : customTransport(customFetch)
}

function customTransport(customFetch: RpcFetch): BackgroundUploadTransport {
  return {
    async post(request) {
      const response = await customFetch(resolveUrl(request.path), {
        method: 'POST',
        ...(request.headers === undefined ? {} : { headers: request.headers }),
        body: request.body,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      })
      return { status: response.status, body: await response.text() }
    },
  }
}

function workerTransport(): BackgroundUploadTransport {
  return {
    post(request) {
      if (typeof Worker !== 'function') {
        return Promise.reject(new Error('background upload requires Web Worker support'))
      }
      const workerUrl = URL.createObjectURL(new Blob([
        `(${backgroundUploadWorker.toString()})()`,
      ], { type: 'text/javascript' }))
      const worker = new Worker(workerUrl, { name: 'dsh-file-upload' })
      URL.revokeObjectURL(workerUrl)
      return new Promise((resolve, reject) => {
        let settled = false
        const abort = (): void => {
          settled = true
          worker.terminate()
          request.signal?.removeEventListener('abort', abort)
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        }
        const finish = (settle: () => void): void => {
          if (settled) return
          settled = true
          request.signal?.removeEventListener('abort', abort)
          worker.terminate()
          settle()
        }
        worker.onmessage = (event: MessageEvent<UploadWorkerOutput>) => {
          const output = event.data
          if (output.kind === 'progress') {
            request.onProgress?.({
              loaded: output.loaded,
              ...(output.total === undefined ? {} : { total: output.total }),
            })
          } else if (output.kind === 'complete') {
            finish(() => { resolve({ status: output.status, body: output.body }) })
          } else {
            finish(() => { reject(new Error(output.message)) })
          }
        }
        worker.onerror = (event) => {
          finish(() => { reject(new Error(event.message || 'background upload worker failed')) })
        }
        if (request.signal?.aborted === true) {
          abort()
          return
        }
        request.signal?.addEventListener('abort', abort, { once: true })
        worker.postMessage({
          url: resolveUrl(request.path).href,
          body: request.body,
          headers: request.headers ?? {},
        } satisfies UploadWorkerStart)
      })
    },
  }
}

function resolveUrl(path: string): URL {
  const pageLocation = Reflect.get(globalThis, 'location') as unknown
  const origin = typeof pageLocation === 'object' && pageLocation !== null
    && 'origin' in pageLocation && typeof pageLocation.origin === 'string'
    ? pageLocation.origin
    : undefined
  return new URL(path, origin === undefined || origin === 'null' ? 'http://dsh.internal' : origin)
}
