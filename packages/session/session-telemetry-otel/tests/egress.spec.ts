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
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import OpenTelemetrySessionBackend, { SessionTelemetryMode } from '../src/index.ts'

let home: string
let previousHome: string | undefined
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-otel-egress-'))
  previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
})
afterAll(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})

/** Mount the shipping backend against an unresolvable collector and let it try to export. */
async function exportThroughBackend(host: string, exporter: Record<string, unknown> = {}): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(OpenTelemetrySessionBackend, {
    mode: SessionTelemetryMode.FULL,
    exporter: { url: `http://${host}/v1/logs`, ...exporter },
  })
  const session = ctx.sessions.create(SessionId('egress'), { meta: { cwd: '/tmp/e' } })
  session.append('turn/start', { turn: 1 })
  ctx.sessionTelemetry.emit({ channel: 'ledger', time: Date.now(), severity: 'info', event: { type: 'probe' } } as never)
  await fiber.dispose()
}


/**
 * Whether this runtime's `http.Agent` honors `proxyEnv`, which is how the OTLP exporter reaches a
 * proxy. Added in Node 24.5 and backported to 22.21; the engines range admits 22.19, 22.20, and
 * 24.0–24.4, where telemetry stays direct.
 */
function supportsAgentProxyEnv(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
  return (major === 24 && minor >= 5) || major > 24 || (major === 22 && minor >= 21)
}

describe('session-telemetry-otel egress', () => {
  it('exports through the proxy', async () => {
    const observed = (await observe(() => exportThroughBackend('otel-proxied.invalid'))).join('|')
    // An older runtime ignores the unknown `proxyEnv` option and keeps telemetry direct — the
    // documented seam, asserted rather than left to chance.
    if (supportsAgentProxyEnv()) expect(observed).toContain('otel-proxied.invalid')
    else expect(observed).toBe('')
  })

  it('reaches no proxy without the agent this package supplies — the gap it closes', async () => {
    const observed = await observe(() => exportThroughBackend('otel-direct.invalid', {
      httpAgentOptions: async (protocol: string) => {
        const core = protocol === 'https:' ? await import('node:https') : await import('node:http')
        return new core.Agent({ keepAlive: false })
      },
    }))
    // The SDK's own default agent is this shape. Restoring it must fail loudly here rather than
    // silently un-proxying telemetry on an upgrade. A per-test host keeps a late-arriving export
    // from an earlier case out of this assertion.
    expect(observed.join('|')).not.toContain('otel-direct.invalid')
  })
})

describe('session-telemetry-otel exporter passthrough', () => {
  it('lets a composition keep its own agent factory, which then owns the routing', async () => {
    let called = 0
    await observe(() => exportThroughBackend('otel-passthrough.invalid', {
      httpAgentOptions: async () => {
        called++
        const core = await import('node:http')
        return new core.Agent({ keepAlive: false })
      },
    }))
    // The exporter option is documented as verbatim passthrough: a composition that supplies its own
    // factory owns the transport, and this package's default must step aside.
    expect(called).toBeGreaterThan(0)
  })

  it('honors exporter.keepAlive on the agent this package supplies', async () => {
    const { createNodeHttpAgent } = await import('@deepseek-ai/dsh-http-proxy')
    const agent = await createNodeHttpAgent('http:', { keepAlive: false })
    try {
      expect((agent as unknown as { options: { keepAlive?: boolean } }).options.keepAlive).toBe(false)
    } finally {
      agent.destroy()
    }
  })
})
