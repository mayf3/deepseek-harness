import http, { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'

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

/** The launch environment of a user who exported one proxy for both schemes. */
function proxyEnv(): { get(name: string): { value: string } | undefined } {
  return { get: name => (name === 'HTTP_PROXY' || name === 'HTTPS_PROXY' ? { value: proxyUrl } : undefined) }
}
async function observe(run: () => Promise<unknown>): Promise<string[]> {
  seen = []
  const dispose = await installProxyFromEnvironment(proxyEnv(), () => undefined)
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


describe('session-telemetry-otel egress', () => {
  it('exports through the proxy', async () => {
    const observed = (await observe(() => exportThroughBackend('otel-proxied.invalid'))).join('|')
    // No runtime gate: the exporter posts through `fetch`, which resolves undici's global
    // dispatcher on every Node this repository supports. The SDK's own `node:http` transport would
    // have needed `http.Agent`'s `proxyEnv`, which arrived in 22.21 and 24.5 — inside the engines
    // range, so telemetry would have stayed direct on 22.19, 22.20, and 24.0–24.4.
    expect(observed).toContain('otel-proxied.invalid')
  })

  it('reaches no proxy over node:http — the transport this exporter no longer uses', async () => {
    const observed = await observe(() => new Promise<void>((resolve) => {
      // The mechanism behind the case above, asserted rather than described: a global dispatcher is
      // undici's, and `node:http` never consults it. An exporter built on the SDK's Node transport
      // would take this path and leave telemetry direct however the proxy is configured.
      http.get('http://otel-direct.invalid/v1/logs', (response) => { response.resume(); resolve() })
        .on('error', () => { resolve() })
    }))
    expect(observed.join('|')).not.toContain('otel-direct.invalid')
  })
})
