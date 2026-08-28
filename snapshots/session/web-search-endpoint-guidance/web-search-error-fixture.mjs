/** Deterministic authentication failure for the search endpoint guidance snapshot. */
import { createServer } from 'node:http'

/** Model-visible endpoint retained by the recorded session. */
const RECORDED_ENDPOINT = 'http://127.0.0.1:43118/anthropic/v1/messages'

/** Cordis plugin name. */
export const name = 'web-search-error-fixture'

/** Start the local Messages endpoint and stop it with the plugin fiber. */
export async function apply(ctx) {
  const server = createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/anthropic/v1/messages') {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'invalid snapshot API key' } }))
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('not found')
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(undefined))
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('web-search-error-fixture: loopback listener has no TCP address')
  }
  const transportEndpoint = `http://127.0.0.1:${String(address.port)}/anthropic/v1/messages`
  const originalFetch = globalThis.fetch
  const fixtureFetch = (input, init) => originalFetch(
    typeof input === 'string' && input === RECORDED_ENDPOINT ? transportEndpoint : input,
    init,
  )
  globalThis.fetch = fixtureFetch
  server.unref()
  ctx.effect(() => async () => {
    globalThis.fetch = originalFetch
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve(undefined))
      server.closeAllConnections()
    })
  }, 'web-search-error-fixture')
}
