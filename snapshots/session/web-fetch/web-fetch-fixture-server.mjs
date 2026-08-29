/**
 * Deterministic HTTP provider for the web-fetch snapshot scenario: a small
 * HTML page (headings, named entities, a GFM table, nested formatting) on a
 * OS-assigned loopback port behind the real address-pinned transport. Recording
 * and replay therefore exercise fetch and markdown rendering without external
 * network while retaining the recorded request URL.
 */
import { createServer } from 'node:http'
import { HttpFetchProvider } from '@deepseek-ai/dsh-web-fetch-http'

/** Model-visible URL retained by the recorded session. */
const RECORDED_URL = 'http://public.test:43117/menu.html'

const PAGE = `<!doctype html>
<html><head><title>Menu</title><style>.x{color:red}</style><script>ignored()</script></head>
<body>
<h1>Caf&eacute; menu</h1>
<p>Prices include <strong>service &amp; <em>tax</em></strong> &mdash; updated daily.</p>
<ul><li>Espresso</li><li>Flat white</li></ul>
<table><thead><tr><th>Drink</th><th>Price</th></tr></thead><tbody><tr><td>Espresso</td><td>&euro;2</td></tr><tr><td>Flat white</td><td>&euro;3</td></tr></tbody></table>
<p>See <a href="https://fixture.invalid/specials">today&rsquo;s specials</a>.</p>
</body></html>
`

/** Cordis plugin name. */
export const name = 'web-fetch-fixture-server'

/** Service used by the fixture provider. */
export const inject = ['web']

const LIMITS = {
  maxResponseBytes: 5_000_000,
  maxBodyChars: 100_000,
  timeoutMs: 30_000,
  maxRedirects: 5,
  userAgent: 'deepseek-harness-snapshot/1.0',
}

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

/**
 * Register the deterministic provider and start its loopback server.
 * @param ctx - Cordis context; the effect disposes the server with the fiber.
 */
export async function apply(ctx) {
  const readiness = Promise.withResolvers()
  let transportUrl
  let startupError

  const resolveAddresses = async (hostname) => {
    if (hostname !== 'public.test') throw new Error(`unexpected snapshot hostname: ${hostname}`)
    return [{ address: '127.0.0.1', family: 4 }]
  }

  const provider = new HttpFetchProvider(LIMITS, resolveAddresses)
  const unregister = ctx.web.registerFetchProvider({
    id: provider.id,
    available: () => provider.available(),
    fetch: async (request, signal) => {
      if (request.url !== RECORDED_URL) throw new Error(`unexpected snapshot URL: ${request.url}`)
      await readiness.promise
      if (startupError !== undefined) throw startupError
      const result = await provider.fetch({ url: transportUrl.toString() }, signal)
      return { ...result, url: RECORDED_URL }
    },
  })
  await ctx.effect(async () => {
    const server = createServer((req, res) => {
      if (req.url === '/menu.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(PAGE)
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
    })
    try {
      await listen(server)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        throw new Error('web-fetch-fixture-server: loopback listener has no TCP address')
      }
      transportUrl = new URL(RECORDED_URL)
      transportUrl.port = String(address.port)
      // The fixture must never hold the process open past protocol shutdown.
      server.unref()
      readiness.resolve(undefined)
      return async () => {
        unregister()
        await close(server)
      }
    } catch (cause) {
      startupError = cause
      readiness.resolve(undefined)
      unregister()
      try {
        await close(server)
      } catch (cleanupError) {
        throw new AggregateError([cause, cleanupError], 'web-fetch-fixture-server: setup and cleanup failed')
      }
      throw cause
    }
  }, 'web-fetch-fixture-server')
}
