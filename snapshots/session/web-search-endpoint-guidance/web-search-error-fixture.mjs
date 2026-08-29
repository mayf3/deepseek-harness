/** Deterministic authentication failure for the search endpoint guidance snapshot. */
import { createServer } from 'node:http'

/** Model-visible endpoint retained by the recorded session. */
const RECORDED_ENDPOINT = 'http://127.0.0.1:43118/anthropic/v1/messages'
const RECORDED_URL = new URL(RECORDED_ENDPOINT)

/** Cordis plugin name. */
export const name = 'web-search-error-fixture'

function listen(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('error', onError)
      reject(error)
    }
    server.once('error', onError)
    try {
      server.listen(0, '127.0.0.1', () => {
        server.off('error', onError)
        resolve(undefined)
      })
    } catch (error) {
      server.off('error', onError)
      reject(error)
    }
  })
}

async function close(server) {
  if (!server.listening) return
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve(undefined))
    server.closeAllConnections()
  })
}

function requestUrl(input) {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (input instanceof Request) return input.url
  return undefined
}

function transportInput(input, transportEndpoint) {
  const url = requestUrl(input)
  if (url === RECORDED_ENDPOINT) {
    return input instanceof Request ? new Request(transportEndpoint, input) : transportEndpoint
  }
  if (url === undefined) return input
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return input
  }
  if (parsed.host === RECORDED_URL.host) {
    throw new Error(`web-search-error-fixture: unexpected URL for recorded authority: ${url}`)
  }
  return input
}

async function cleanup(server, restoreFetch) {
  const errors = []
  try {
    restoreFetch()
  } catch (error) {
    errors.push(error)
  }
  try {
    await close(server)
  } catch (error) {
    errors.push(error)
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'web-search-error-fixture: cleanup failed')
}

/** Start the local Messages endpoint and stop it with the plugin fiber. */
export async function apply(ctx) {
  await ctx.effect(async () => {
    const server = createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/anthropic/v1/messages') {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'invalid snapshot API key' } }))
        return
      }
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('not found')
    })
    try {
      await listen(server)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        throw new Error('web-search-error-fixture: loopback listener has no TCP address')
      }
      const transportEndpoint = `http://127.0.0.1:${String(address.port)}/anthropic/v1/messages`
      server.unref()
      const originalFetch = globalThis.fetch
      const fixtureFetch = async (input, init) => originalFetch(transportInput(input, transportEndpoint), init)
      globalThis.fetch = fixtureFetch
      return () => cleanup(server, () => {
        if (globalThis.fetch !== fixtureFetch) {
          throw new Error('web-search-error-fixture: global fetch owner changed before cleanup')
        }
        globalThis.fetch = originalFetch
      })
    } catch (cause) {
      try {
        await close(server)
      } catch (cleanupError) {
        throw new AggregateError([cause, cleanupError], 'web-search-error-fixture: setup and cleanup failed')
      }
      throw cause
    }
  }, 'web-search-error-fixture')
}
