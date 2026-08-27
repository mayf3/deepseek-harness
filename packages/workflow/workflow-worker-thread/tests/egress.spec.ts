import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { installGlobalProxy, type ProxyPolicy } from '@deepseek-ai/dsh-http-proxy'

let seen: string[] = []
let proxy: Server
let proxyUrl: string

beforeAll(async () => {
  proxy = createServer((request, response) => {
    seen.push(`REQ ${request.url ?? ''}`)
    response.writeHead(502); response.end('fake-proxy')
  })
  proxy.on('connect', (request, socket) => {
    seen.push(`CONNECT ${request.url ?? ''}`)
    socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); socket.end()
  })
  const a = await new Promise<AddressInfo>((r) => { proxy.listen(0, '127.0.0.1', () => { r(proxy.address() as AddressInfo) }) })
  proxyUrl = `http://127.0.0.1:${String(a.port)}`
})
afterAll(async () => { await new Promise<void>((r) => { proxy.close(() => { r() }) }) })

function policy(): ProxyPolicy {
  return { httpProxy: proxyUrl, httpsProxy: proxyUrl, noProxy: '', source: 'env' }
}
async function observe(run: () => Promise<unknown>): Promise<string[]> {
  seen = []
  const dispose = await installGlobalProxy(policy())
  try { await run().catch(() => undefined) } finally { await dispose() }
  return seen
}
import { Worker } from 'node:worker_threads'
import { once } from 'node:events'
import { workerSpawnEnv } from '../src/host.ts'

describe('worker thread egress', () => {
  it('a worker honors the host policy through workerSpawnEnv', async () => {
    const observed = await observe(async () => {
      const worker = new Worker(
        `import { parentPort, workerData } from 'node:worker_threads'
         let out; try { out = await (await fetch(workerData.u)).text() } catch (e) { out = 'ERR' + String(e.cause?.code) }
         parentPort.postMessage(out)`,
        { eval: true, workerData: { u: 'http://worker-probe.invalid/x' }, env: workerSpawnEnv(), execArgv: [] },
      )
      await once(worker, 'message')
      await worker.terminate()
    })
    expect(observed.join('|')).toContain('worker-probe.invalid')
  })
})
