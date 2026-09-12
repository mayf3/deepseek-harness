/** Isolated Stagehand Workers own CDP connections; the host owns browser processes. */

import { Worker } from 'node:worker_threads'
import type { ClientLLM } from '@browserbasehq/stagehand'
import type { NativeBrowserConfig, NativeBrowserRuntime } from './native.ts'
import { answer, request } from './worker-rpc.ts'

/**
 * Connect Stagehand through an isolated Worker that receives no ambient environment.
 * @param config - resolved CDP connection and operation options.
 * @param generate - host-owned, logged inference callback.
 * @param signal - cancellation of lazy browser acquisition.
 * @param warn - report SDK cleanup failures after connection termination.
 * @returns an initialized runtime whose close awaits connection release.
 */
export async function openBrowserWorker(
  config: NativeBrowserConfig, generate: ClientLLM['generate'], signal: AbortSignal, warn: (message: string) => void,
): Promise<NativeBrowserRuntime> {
  signal.throwIfAborted()
  const { ClientLLMSchema } = await import('@browserbasehq/stagehand')
  signal.throwIfAborted()
  const entry = new URL('./worker.js', import.meta.url)
  // The SDK Worker only connects over CDP; host paths, credentials, and proxy variables stay outside it.
  const env: NodeJS.ProcessEnv = {}
  if (process.env.TSX_TSCONFIG_PATH !== undefined) env.TSX_TSCONFIG_PATH = process.env.TSX_TSCONFIG_PATH
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
  worker.once('exit', (code) => { lifetime.abort(new Error(`Stagehand browser Worker exited (${code})`)) })
  let closing: Promise<void> | undefined
  const close = () => closing ??= (async () => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        request(worker, 'close', undefined, lifetime.signal),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => { reject(new Error('Stagehand connection cleanup timed out')) }, config.shutdownGraceMs)
        }),
      ])
    } catch (error) {
      warn(`Stagehand SDK cleanup did not finish: ${String(error)}`)
    } finally {
      clearTimeout(timeout)
      await terminate()
    }
    worker.removeAllListeners()
  })()
  const validatedGenerate = ClientLLMSchema.shape.generate.implementAsync(generate)
  worker.on('message', (raw: unknown) => {
    void answer(raw, async (method, args) => {
      if (method !== 'generate') throw new Error(`Unsupported Stagehand Worker request: ${method}`)
      return validatedGenerate(args as Parameters<ClientLLM['generate']>[0])
    }).catch((error: unknown) => {
      warn(`Stagehand Worker protocol failed: ${String(error)}`)
      void close().catch((cleanupError: unknown) => { lifetime.abort(cleanupError) })
    })
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
  return {
    async execute(method, args, signal) {
      signal?.throwIfAborted()
      lifetime.signal.throwIfAborted()
      if (closing !== undefined) throw new Error('Stagehand browser Worker is closed')
      const canceled = () => { void close().catch((error: unknown) => { lifetime.abort(error) }) }
      signal?.addEventListener('abort', canceled, { once: true })
      try {
        return await request(worker, method, args, lifetime.signal)
      } catch (error) {
        signal?.throwIfAborted()
        throw error
      } finally {
        signal?.removeEventListener('abort', canceled)
      }
    },
    close,
  }
}
