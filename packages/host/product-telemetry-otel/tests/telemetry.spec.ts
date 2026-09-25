import { Agent, createServer, type IncomingHttpHeaders } from 'node:http'
import { once } from 'node:events'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LoggerProvider } from '@opentelemetry/sdk-logs'
import { SeverityNumber } from '@opentelemetry/api-logs'
import { JsonLogsSerializer } from '@opentelemetry/otlp-transformer'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import ProductTelemetry, { Config, SESSION_LOG_MAX_REQUEST_BYTES, SessionLogReporter, type SessionLogRecord } from '../src/index.ts'

interface Capture {
  bytes: number
  headers: IncomingHttpHeaders
  body: { resourceLogs: { resource: unknown; scopeLogs: { logRecords: Record<string, unknown>[] }[] }[] }
}
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  try {
    for (const dispose of cleanup.splice(0).reverse()) await dispose()
  } finally {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    vi.useRealTimers()
  }
})

beforeEach(() => {
  vi.stubEnv('OTEL_EXPORTER_OTLP_COMPRESSION', undefined)
  vi.stubEnv('OTEL_EXPORTER_OTLP_LOGS_COMPRESSION', undefined)
})

async function collector(statuses = [200], beforeRespond?: () => Promise<void>) {
  const captures: Capture[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      const bytes = req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw
      captures.push({ bytes: bytes.length, headers: req.headers, body: JSON.parse(bytes.toString()) as Capture['body'] })
      void (async () => {
        await beforeRespond?.()
        res.writeHead(statuses.shift() ?? 200, { 'content-type': 'application/json' }).end('{}')
      })()
    })
  })
  cleanup.push(async () => {
    const closed = once(server, 'close')
    server.close()
    server.closeAllConnections()
    await closed
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('collector has no port')
  return { captures, endpoint: `http://127.0.0.1:${address.port}/v1/logs` }
}

function config(endpoint: string, overrides: Partial<Config> = {}): Config {
  return Config({ endpoint, serviceName: 'synthetic-test', serviceVersion: '1', scheduledDelayMillis: 60_000, ...overrides })
}

function context() {
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  return ctx
}

const event = { eventName: 'telemetry.synthetic', body: 'Synthetic test', timestamp: 1_800_000_000_000 }

describe('explicit product telemetry', () => {
  it.each(['gzip', 'none', undefined] as const)('drains typed events with %s compression and removes the service', async (compression) => {
    const target = await collector()
    const ctx = context()
    const fiber = await ctx.plugin(ProductTelemetry, config(target.endpoint, compression === undefined ? {} : { compression }))
    const service = ctx.productTelemetry
    expect(target.captures).toEqual([])
    service.emit({ ...event, attributes: { text: 'test', count: 2, duration: 1.5, synthetic: true, model: { provider: 'test', count: 1, enabled: false } } })
    service.emit({ ...event, severityNumber: SeverityNumber.ERROR })
    await fiber.dispose()
    expect(ctx.get('productTelemetry')).toBeUndefined()
    service.emit(event)
    expect(target.captures).toHaveLength(1)
    const [capture] = target.captures
    expect(capture?.headers['x-channel']).toBe('dsh_otel_report')
    expect(capture?.headers['content-encoding']).toBe(compression === 'gzip' ? 'gzip' : undefined)
    const logs = capture?.body.resourceLogs.flatMap(r => r.scopeLogs.flatMap(s => s.logRecords))
    expect(logs).toHaveLength(2)
    expect(logs?.[0]).toMatchObject({
      eventName: event.eventName, body: { stringValue: event.body }, severityNumber: 9,
      timeUnixNano: '1800000000000000000',
    })
    expect(logs?.[0]?.['attributes']).toEqual(expect.arrayContaining([
      { key: 'text', value: { stringValue: 'test' } },
      { key: 'count', value: { intValue: 2 } },
      { key: 'duration', value: { doubleValue: 1.5 } },
      { key: 'synthetic', value: { boolValue: true } },
      { key: 'model', value: { kvlistValue: { values: [{ key: 'provider', value: { stringValue: 'test' } }, { key: 'count', value: { intValue: 1 } }, { key: 'enabled', value: { boolValue: false } }] } } },
    ]))
    expect(Number(logs?.[0]?.['observedTimeUnixNano'])).toBeGreaterThan(0)
    expect(logs?.[1]?.['severityNumber']).toBe(17)
    expect(JSON.stringify(capture)).not.toContain('user.id')
  })

  it('isolates collector headers from ambient OpenTelemetry credentials', async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_HEADERS', 'Authorization=Bearer%20synthetic-secret,x-user-id=synthetic-user')
    vi.stubEnv('OTEL_EXPORTER_OTLP_LOGS_HEADERS', 'x-log-token=synthetic-token,x-channel=other-collector')
    const target = await collector()
    const ctx = context()
    const fiber = await ctx.plugin(ProductTelemetry, config(target.endpoint))
    ctx.productTelemetry.emit(event)
    await fiber.dispose()
    expect(target.captures).toHaveLength(1)
    expect(target.captures[0]?.headers).toMatchObject({ 'x-channel': 'dsh_otel_report' })
    expect(target.captures[0]?.headers).not.toHaveProperty('authorization')
    expect(target.captures[0]?.headers).not.toHaveProperty('x-user-id')
    expect(target.captures[0]?.headers).not.toHaveProperty('x-log-token')
    expect(process.env['OTEL_EXPORTER_OTLP_HEADERS']).toContain('synthetic-secret')
  })

  it('does not export on mount or empty shutdown', async () => {
    const target = await collector()
    const fiber = await context().plugin(ProductTelemetry, config(target.endpoint))
    await fiber.dispose()
    expect(target.captures).toEqual([])
  })

  it('exports at the batch threshold and retries a transient rejection', async () => {
    const target = await collector([503, 200])
    const ctx = context()
    await ctx.plugin(ProductTelemetry, config(target.endpoint, { maxExportBatchSize: 1 }))
    ctx.productTelemetry.emit(event)
    await vi.waitFor(() => { expect(target.captures).toHaveLength(2) }, { timeout: 10_000 })
    expect(target.captures[0]?.body).toEqual(target.captures[1]?.body)
  })

  it('exports a partial batch on its configured interval', async () => {
    const target = await collector()
    const ctx = context()
    await ctx.plugin(ProductTelemetry, config(target.endpoint, { scheduledDelayMillis: 10 }))
    ctx.productTelemetry.emit(event)
    await vi.waitFor(() => { expect(target.captures).toHaveLength(1) })
  })

  it('reports a permanent export rejection without failing the caller', async () => {
    const target = await collector([400])
    const ctx = context()
    const warn = vi.spyOn(ctx.logger, 'warn')
    const fiber = await ctx.plugin(ProductTelemetry, config(target.endpoint))
    expect(() => { ctx.productTelemetry.emit(event) }).not.toThrow()
    await fiber.dispose()
    expect(target.captures).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith('Product telemetry export failed', expect.any(Error))
  })

  it.each([
    { endpoint: 'broken' }, { endpoint: 'ftp://collector.test/logs' },
    { channel: '' }, { channel: 'bad\nchannel' }, { channel: '中文' }, { timeoutMillis: 0 },
    { maxExportBatchSize: 0 }, { maxExportBatchSize: 2, maxQueueSize: 1 },
    { maxQueueSize: -1 }, { scheduledDelayMillis: 0 }, { exportTimeoutMillis: Infinity },
    { shutdownTimeoutMillis: 2_147_483_648 },
  ])('rejects invalid configuration %j before exposing the service', (invalid) => {
    const ctx = context()
    expect(() => new ProductTelemetry(ctx, config('http://collector.test/v1/logs', invalid))).toThrow()
    expect(ctx.get('productTelemetry')).toBeUndefined()
  })

  it.each([
    [{ endpoint: 'broken' }, 'endpoint must be a valid HTTP(S) URL'],
    [{ channel: 'bad\nchannel' }, 'channel must be a valid HTTP header value'],
  ] as const)('names invalid transport fields before registering the service', (invalid, message) => {
    const ctx = context()
    expect(() => new ProductTelemetry(ctx, config('http://collector.test/v1/logs', invalid)))
      .toThrow(`product-telemetry-otel: ${message}`)
    expect(ctx.get('productTelemetry')).toBeUndefined()
  })

  it.each([
    ['OTEL_EXPORTER_OTLP_COMPRESSION', 'gzip'],
    ['OTEL_EXPORTER_OTLP_LOGS_COMPRESSION', 'gzip'],
  ])('honors %s when compression is omitted', async (name, value) => {
    vi.stubEnv(name, value)
    const target = await collector()
    const ctx = context()
    const fiber = await ctx.plugin(ProductTelemetry, config(target.endpoint))
    ctx.productTelemetry.emit(event)
    await fiber.dispose()
    expect(target.captures[0]?.headers['content-encoding']).toBe('gzip')
  })

  it('bounds a stalled shutdown and observes its later settlement', async () => {
    const target = await collector()
    const ctx = context()
    const warn = vi.spyOn(ctx.logger, 'warn')
    const fiber = await ctx.plugin(ProductTelemetry, config(target.endpoint, { shutdownTimeoutMillis: 20 }))
    const pending = Promise.withResolvers<undefined>()
    vi.spyOn(LoggerProvider.prototype, 'shutdown').mockReturnValue(pending.promise)
    vi.useFakeTimers()
    const disposal = fiber.dispose()
    await vi.advanceTimersByTimeAsync(20)
    await disposal
    expect(warn).toHaveBeenCalledWith('Product telemetry shutdown deadline exceeded; pending events may be lost')
    pending.resolve(undefined)
    await pending.promise
    await vi.advanceTimersByTimeAsync(0)
  })
})


function sessionRecord(text: string, seq = 0): SessionLogRecord {
  return {
    sessionId: SessionId('synthetic-session'),
    event: { type: 'user/message', seq: SessionSeq(seq), time: 1_800_000_000_000, surfaceOp: 'append',
      data: { content: [{ type: 'text', text }], nested: { items: [null, true, false, 0, 1.5, { text }] } } },
  }
}

function logs(capture: Capture) {
  return capture.body.resourceLogs.flatMap(resource => resource.scopeLogs.flatMap(scope => scope.logRecords))
}

function contents(captures: Capture[]): string[] {
  return captures.flatMap(capture => logs(capture).map((record) => {
    const attributes = record['attributes'] as { key: string; value: { stringValue: string } }[]
    return attributes.find(attribute => attribute.key === 'content')!.value.stringValue
  }))
}

function parseContent(content: string): unknown {
  return JSON.parse(content)
}

describe('Session-log reporting', () => {
  it('keeps product events in separate requests and preserves the complete nested event', async () => {
    vi.stubEnv('OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT', '8')
    vi.stubEnv('OTEL_EXPORTER_OTLP_HEADERS', 'Authorization=Bearer%20unrelated')
    const target = await collector()
    const ctx = context()
    const fiber = await ctx.plugin(ProductTelemetry, config(target.endpoint))
    const record = sessionRecord('中文\n"quoted"\\path 😀')
    ctx.productTelemetry.emit(event)
    ctx.productTelemetry.reportSessionLog(record)
    await fiber.dispose()
    expect(target.captures).toHaveLength(2)
    const sessionCapture = target.captures.find(capture => logs(capture)[0]?.['eventName'] === 'session-log')!
    expect(logs(sessionCapture)).toHaveLength(1)
    expect(logs(sessionCapture)[0]).toMatchObject({
      eventName: 'session-log', body: { stringValue: 'session-log' },
      attributes: [
        { key: 'sessionId', value: { stringValue: record.sessionId } },
        { key: 'content', value: { stringValue: JSON.stringify(record.event) } },
      ],
    })
    expect(JSON.parse(contents([sessionCapture])[0]!)).toEqual(record.event)
    expect(sessionCapture.headers).not.toHaveProperty('authorization')
  })

  it.each(['gzip', 'none'] as const)('splits real 4 MB batches before %s compression without losing event order', async (compression) => {
    const target = await collector()
    const ctx = context()
    const fiber = await ctx.plugin(ProductTelemetry, config(target.endpoint, { compression }))
    const records = [0, 1, 2].map(seq => sessionRecord('中"\\'.repeat(100_000), seq))
    for (const record of records) ctx.productTelemetry.reportSessionLog(record)
    await fiber.dispose()
    expect(target.captures.length).toBeGreaterThan(1)
    expect(target.captures.every(capture => capture.bytes <= SESSION_LOG_MAX_REQUEST_BYTES)).toBe(true)
    expect(contents(target.captures).map(parseContent)).toEqual(records.map(record => record.event))
  })

  it('admits an exact byte-limit request and rejects a single event one byte above it', async () => {
    const target = await collector()
    const ctx = context()
    const record = sessionRecord('边界"\\')
    const baseline = await ctx.plugin(ProductTelemetry, config(target.endpoint))
    ctx.productTelemetry.reportSessionLog(record)
    await baseline.dispose()
    const limit = target.captures[0]!.bytes
    const exact = await ctx.plugin(ProductTelemetry, config(target.endpoint, { sessionLog: { maxRequestBytes: limit } }))
    ctx.productTelemetry.reportSessionLog(record)
    await exact.dispose()
    expect(target.captures).toHaveLength(2)
    expect(target.captures[1]!.bytes).toBe(limit)
    const warn = vi.spyOn(ctx.logger, 'warn')
    const tooSmall = await ctx.plugin(ProductTelemetry, config(target.endpoint, { sessionLog: { maxRequestBytes: limit - 1 } }))
    ctx.productTelemetry.reportSessionLog(record)
    await tooSmall.dispose()
    expect(target.captures).toHaveLength(2)
    expect(warn).toHaveBeenCalledWith('Session log record rejected; content was not truncated', expect.any(Error))
  })

  it('rejects an oversized event while still sending the events before and after it', async () => {
    const target = await collector()
    const ctx = context()
    const warn = vi.spyOn(ctx.logger, 'warn')
    const fiber = await ctx.plugin(ProductTelemetry, config(target.endpoint))
    const records = [sessionRecord('before'), sessionRecord('x'.repeat(SESSION_LOG_MAX_REQUEST_BYTES), 1), sessionRecord('after', 2)]
    for (const record of records) ctx.productTelemetry.reportSessionLog(record)
    await fiber.dispose()
    expect(contents(target.captures).map(parseContent)).toEqual([records[0]!.event, records[2]!.event])
    expect(warn).toHaveBeenCalledWith('Session log record rejected; content was not truncated', expect.any(Error))
    expect(target.captures.every(capture => capture.bytes <= SESSION_LOG_MAX_REQUEST_BYTES)).toBe(true)
  })

  it('continues later byte batches after a permanent rejection', async () => {
    const target = await collector([400, 200])
    const ctx = context()
    const warn = vi.spyOn(ctx.logger, 'warn')
    const fiber = await ctx.plugin(ProductTelemetry, config(target.endpoint, { sessionLog: { maxRequestBytes: 1300 } }))
    ctx.productTelemetry.reportSessionLog(sessionRecord('first'.repeat(25)))
    ctx.productTelemetry.reportSessionLog(sessionRecord('second'.repeat(25), 1))
    await fiber.dispose()
    expect(target.captures).toHaveLength(2)
    expect(warn).toHaveBeenCalledWith('Session log export failed', expect.any(Error))
  })

  it.each([0, -1, 1.5, 4_000_001, Infinity])('refuses an invalid request limit %s', (maxRequestBytes) => {
    expect(() => new SessionLogReporter({
      exporter: { url: 'http://collector.test/v1/logs' }, resourceAttributes: {}, maxRequestBytes, onFailure: vi.fn(),
    })).toThrow('maxRequestBytes')
  })
})


it('honors explicit asynchronous headers and agent factories for Session logs', async () => {
  const target = await collector()
  const agent = new Agent({ keepAlive: false })
  cleanup.push(async () => { agent.destroy() })
  const failures = vi.fn()
  const reporter = new SessionLogReporter({
    exporter: { url: target.endpoint, userAgent: 'session-test', headers: async () => ({ 'x-channel': 'test-channel' }), httpAgentOptions: async () => agent },
    resourceAttributes: {}, onFailure: failures,
  })
  cleanup.push(() => reporter.shutdown())
  reporter.reportSessionLog(sessionRecord('explicit headers'))
  await reporter.shutdown()
  expect(failures).not.toHaveBeenCalled()
  expect(target.captures[0]!.headers['x-channel']).toBe('test-channel')
  expect(target.captures[0]!.headers['user-agent']).toContain('session-test')
})

it.each([new Error('serializer failed'), 'serializer failed', undefined])('reports serialization failure %s without sending a partial request', async (failure) => {
  const target = await collector()
  const failures = vi.fn()
  const reporter = new SessionLogReporter({
    exporter: { url: target.endpoint, keepAlive: false }, resourceAttributes: {}, onFailure: failures,
  })
  cleanup.push(() => reporter.shutdown())
  reporter.reportSessionLog(sessionRecord('not exported'))
  vi.spyOn(JsonLogsSerializer, 'serializeRequest').mockImplementationOnce(() => {
    if (failure === undefined) return undefined
    throw failure
  })
  await reporter.shutdown()
  expect(target.captures).toEqual([])
  expect(failures).toHaveBeenCalledWith('Session log export failed', expect.any(Error))
})


it.each([
  ['maxQueueSize', 0], ['maxExportBatchSize', 0], ['scheduledDelayMillis', 0], ['exportTimeoutMillis', 0],
  ['maxQueueSize', 1.5], ['exportTimeoutMillis', 2_147_483_648],
] as const)(
  'rejects invalid Session queue %s=%s before registering a service', (key, value) => {
    const ctx = context()
    expect(() => new ProductTelemetry(ctx, config('http://collector.test/v1/logs', {
      sessionLog: { processor: { [key]: value } },
    }))).toThrow(`processor.${key}`)
    expect(ctx.get('productTelemetry')).toBeUndefined()
  },
)


it('drains every split request when disposal starts during the first request', async () => {
  const received = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const target = await collector([200], async () => {
    received.resolve(undefined)
    await release.promise
  })
  const ctx = context()
  cleanup.push(async () => { release.resolve(undefined) })
  const fiber = await ctx.plugin(ProductTelemetry, config(target.endpoint, {
    sessionLog: { maxRequestBytes: 1300, processor: { maxExportBatchSize: 3, scheduledDelayMillis: 60_000 } },
  }))
  const service = ctx.productTelemetry
  const records = [0, 1, 2].map(seq => sessionRecord('content'.repeat(20), seq))
  for (const record of records) service.reportSessionLog(record)
  await received.promise
  let disposed = false
  const disposal = fiber.dispose().then(() => { disposed = true })
  await Promise.resolve()
  expect(disposed).toBe(false)
  release.resolve(undefined)
  await disposal
  expect(target.captures).toHaveLength(3)
  expect(contents(target.captures).map(parseContent)).toEqual(records.map(record => record.event))
  service.reportSessionLog(sessionRecord('after shutdown'))
  expect(target.captures).toHaveLength(3)
})


it('constructs and disposes the product service without Session-specific overrides', async () => {
  const target = await collector()
  const ctx = context()
  const { sessionLog: _sessionLog, ...options } = config(target.endpoint)
  const service = new ProductTelemetry(ctx, options)
  service.reportSessionLog(sessionRecord('default Session queue'))
  await ctx.fiber.dispose()
  expect(target.captures).toHaveLength(1)
})
