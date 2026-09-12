/** Real Workers pin initialization, inference, crash, and quiescent termination. */

import { once } from 'node:events'
import { connect } from 'node:net'
import type { Worker } from 'node:worker_threads'
import type { ClientLLM } from '@browserbasehq/stagehand'
import { afterEach, expect, it, vi } from 'vitest'
import { openAttachedBrowser } from '../src/worker-client.ts'
import type { NativeBrowserConfig, NativeBrowserRuntime } from '../src/native.ts'

const state = vi.hoisted(() => ({ workers: [] as Worker[], entries: [] as string[] }))
vi.mock('node:worker_threads', async (importActual) => {
  const actual = await importActual<typeof import('node:worker_threads')>()
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(entry: URL, options: import('node:worker_threads').WorkerOptions) {
        super(new URL('./fixtures/attachment-worker.mjs', import.meta.url), options)
        state.entries.push(entry.href)
        state.workers.push(this)
      }
    },
  }
})

const result: Awaited<ReturnType<ClientLLM['generate']>> = {
  role: 'assistant', content: { type: 'text', text: '{"heading":"Fixture"}' }, outputFormat: 'json_schema',
  structuredContent: { heading: 'Fixture' }, stopReason: 'stop',
}
const generation: Parameters<ClientLLM['generate']>[0] = {
  messages: [{ role: 'user', content: { type: 'text', text: 'Read the heading.' } }],
  responseFormat: { type: 'json_schema', name: 'heading', schema: { type: 'object' } },
}
const runtimes: NativeBrowserRuntime[] = []
afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map(runtime => runtime.close()))
  await Promise.all(state.workers.splice(0).map(worker => worker.terminate()))
  state.entries = []
  vi.unstubAllEnvs()
})

function config(scenario = 'ready'): NativeBrowserConfig {
  return { mode: 'attach', cdpEndpoint: `fixture://${scenario}`, headless: true, operationTimeoutMs: 30000, shutdownGraceMs: 1000 }
}

async function open(scenario = 'ready', generate: ClientLLM['generate'] = async () => result) {
  const runtime = await openAttachedBrowser(config(scenario), generate, new AbortController().signal)
  runtimes.push(runtime)
  return runtime
}

it('validates host inference and awaits Worker exit before releasing its listener', async () => {
  const generate = vi.fn(async () => result)
  const runtime = await open('ready', generate)
  const worker = state.workers[0]!
  expect(decodeURIComponent(state.entries[0]!)).toContain('tsx')
  const { port } = await runtime.execute('tabs', { action: 'list' }) as { port: number }
  const socket = connect(port, '127.0.0.1')
  await once(socket, 'connect')
  socket.destroy()
  expect(await runtime.execute('act', generation)).toEqual(result)
  expect(generate).toHaveBeenCalledWith(generation)
  await expect(runtime.execute('act', { messages: 'invalid' })).rejects.toThrow()
  expect(generate).toHaveBeenCalledTimes(1)
  const exited = once(worker, 'exit')
  await runtime.close()
  await exited
  expect(worker.threadId).toBe(-1)
  const disconnected = connect(port, '127.0.0.1')
  const [error] = await once(disconnected, 'error') as [Error]
  expect((error as NodeJS.ErrnoException).code).toBe('ECONNREFUSED')
})

it('preserves initialization failures while terminating the failed Worker', async () => {
  await expect(open('failure')).rejects.toThrow('Extension initialization failed')
  expect(state.workers[0]?.threadId).toBe(-1)
})

it('terminates a Worker whose initialization overlaps acquisition cancellation', async () => {
  const controller = new AbortController()
  const opening = openAttachedBrowser(config('opening'), async () => result, controller.signal)
  const observed = expect(opening).rejects.toThrow('Acquisition canceled')
  await vi.waitFor(() => { expect(state.workers).toHaveLength(1) })

  controller.abort(new Error('Acquisition canceled'))
  await observed
  expect(state.workers[0]?.threadId).toBe(-1)
})

it('fails active and later operations when the Worker exits', async () => {
  const runtime = await open('crash')
  const exited = once(state.workers[0]!, 'exit')
  await expect(runtime.execute('tabs', { action: 'list' })).rejects.toThrow(/Worker (exited|reply channel closed)/u)
  await exited
  await expect(runtime.execute('tabs', { action: 'list' })).rejects.toThrow('Worker exited (23)')
})

it('terminates stalled SDK cleanup and reports the failed cleanup', async () => {
  const runtime = await openAttachedBrowser({ ...config('closing'), shutdownGraceMs: 20 }, async () => result, new AbortController().signal)
  runtimes.push(runtime)
  const closing = runtime.close()
  await expect(runtime.execute('tabs', { action: 'list' })).rejects.toThrow('attachment is closed')
  await expect(closing).rejects.toThrow('attachment cleanup timed out')
  expect(state.workers[0]?.threadId).toBe(-1)
})


it.each(['error', 'malformed'] as const)('terminates pending operations after a Worker %s', async (scenario) => {
  const runtime = await open(scenario)
  await expect(runtime.execute('tabs', { action: 'list' })).rejects.toThrow()
  await expect(runtime.close()).rejects.toThrow()
  expect(state.workers[0]?.threadId).toBe(-1)
})

it('rejects unsupported Worker requests without calling the model', async () => {
  const generate = vi.fn(async () => result)
  const runtime = await open('unsupported', generate)
  await expect(runtime.execute('tabs', { action: 'list' })).rejects.toThrow('Unsupported Stagehand Worker request: unsupported')
  expect(generate).not.toHaveBeenCalled()
})

it('preserves the explicit source tsconfig for its Worker', async () => {
  vi.stubEnv('TSX_TSCONFIG_PATH', '/fixture/tsconfig.json')
  const runtime = await open()
  expect(await runtime.execute('tabs', { action: 'list' })).toHaveProperty('port')
})
