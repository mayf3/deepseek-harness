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
async function exportThroughBackend(): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(OpenTelemetrySessionBackend, {
    mode: SessionTelemetryMode.FULL,
    exporter: { url: 'http://otel-probe.invalid/v1/logs' },
  })
  const session = ctx.sessions.create(SessionId('egress'), { meta: { cwd: '/tmp/e' } })
  session.append('turn/start', { turn: 1 })
  ctx.sessionTelemetry.emit({ channel: 'ledger', time: Date.now(), severity: 'info', event: { type: 'probe' } } as never)
  await fiber.dispose()
}

describe('session-telemetry-otel egress', () => {
  it('exports through the proxy', async () => {
    expect((await observe(exportThroughBackend)).join('|')).toContain('otel-probe.invalid')
  })
})
