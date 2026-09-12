/** Attachment cleanup releases Stagehand before terminating its owned sockets. */

import { Worker } from 'node:worker_threads'
import type { ClientLLM } from '@browserbasehq/stagehand'
import type { NativeBrowserConfig, NativeBrowserRuntime } from './native.ts'
import { answer, request } from './worker-rpc.ts'

/**
 * Attach through a dedicated Worker; disposal never sends Browser.close.
 * @param config - resolved browser options with an explicit attachment endpoint.
 * @param generate - host-owned, logged inference callback.
 * @param signal - cancellation of lazy browser acquisition.
 * @returns an initialized runtime whose close awaits Worker termination.
 */
export async function openAttachedBrowser(config: NativeBrowserConfig, generate: ClientLLM['generate'], signal: AbortSignal): Promise<NativeBrowserRuntime> {
  signal.throwIfAborted()
  const { ClientLLMSchema } = await import('@browserbasehq/stagehand')
  signal.throwIfAborted()
  const entry = new URL('./worker.js', import.meta.url)
  const env = process.env.TSX_TSCONFIG_PATH === undefined ? {} : { TSX_TSCONFIG_PATH: process.env.TSX_TSCONFIG_PATH }
  let worker: Worker
  /* v8 ignore next 3 -- native.e2e.ts starts the bundled Worker through a plain-Node provider fixture. */
  if (!import.meta.url.endsWith('.ts')) {
    worker = new Worker(entry, { workerData: config, execArgv: [], env })
  } else {
    const source = new URL('./worker.ts', import.meta.url)
    const bootstrap = `import { register } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))}; register(); await import(${JSON.stringify(source.href)})`
    worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`), { workerData: config, execArgv: [], env })
  }
  let termination: Promise<number> | undefined
  const terminate = () => termination ??= worker.terminate()
  const lifetime = new AbortController()
  worker.once('error', (error) => { lifetime.abort(error) })
  worker.once('exit', (code) => { lifetime.abort(new Error(`Stagehand attachment Worker exited (${code})`)) })
  const validatedGenerate = ClientLLMSchema.shape.generate.implementAsync(generate)
  worker.on('message', (raw: unknown) => {
    void answer(raw, async (method, args) => {
      if (method !== 'generate') throw new Error(`Unsupported Stagehand Worker request: ${method}`)
      return validatedGenerate(args as Parameters<ClientLLM['generate']>[0])
    }).catch((error: unknown) => { lifetime.abort(error); void terminate() })
  })
  const abortOpening = () => { void terminate() }
  signal.addEventListener('abort', abortOpening, { once: true })
  try {
    await request(worker, 'ready', undefined, lifetime.signal)
    signal.throwIfAborted()
    lifetime.signal.throwIfAborted()
  } catch (error) {
    const failure: unknown = lifetime.signal.reason ?? error
    await terminate()
    signal.throwIfAborted()
    throw failure
  } finally {
    signal.removeEventListener('abort', abortOpening)
  }
  let closing: Promise<void> | undefined
  return {
    async execute(method, args) {
      lifetime.signal.throwIfAborted()
      if (closing !== undefined) throw new Error('Stagehand attachment is closed')
      return request(worker, method, args, lifetime.signal)
    },
    close() {
      closing ??= (async () => {
        let timeout: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            request(worker, 'close', undefined, lifetime.signal),
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(() => { reject(new Error('Stagehand attachment cleanup timed out')) }, config.shutdownGraceMs)
            }),
          ])
        } finally {
          clearTimeout(timeout)
          await terminate()
          worker.removeAllListeners()
        }
      })()
      return closing
    },
  }
}
