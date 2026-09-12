/** Deterministic Worker peer with a real owned listener and inference round trips. */
import { MessageChannel, parentPort, workerData } from 'node:worker_threads'
import { createServer } from 'node:net'
import { once } from 'node:events'

const server = createServer(socket => socket.end())
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const scenario = new URL(workerData.cdpEndpoint).hostname
parentPort.on('message', async ({ method, args, reply }) => {
  if (method === 'ready' && scenario === 'opening') return
  if (method === 'close' && scenario === 'closing') return
  if (method === 'tabs' && scenario === 'error') throw new Error('Fixture worker crashed')
  if (method === 'tabs' && scenario === 'malformed') { parentPort.postMessage({ invalid: true }); return }
  if (method === 'tabs' && scenario === 'crash') { process.exit(23); return }
  if (method === 'ready' && scenario === 'failure') {
    reply.postMessage({ ok: false, error: 'Extension initialization failed' })
  } else if (method === 'act' || (method === 'tabs' && scenario === 'unsupported')) {
    const { port1, port2 } = new MessageChannel()
    const response = once(port1, 'message')
    parentPort.postMessage({ method: scenario === 'unsupported' ? 'unsupported' : 'generate', args, reply: port2 }, [port2])
    reply.postMessage((await response)[0])
    port1.close()
  } else {
    if (method === 'close') await new Promise(resolve => server.close(resolve))
    reply.postMessage({ ok: true, value: { port: server.address()?.port } })
  }
  reply.close()
})
