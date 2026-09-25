/** Session-log records in an independent SDK queue with byte-bounded OTLP requests. */
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { Attributes } from '@opentelemetry/api'
import { SeverityNumber } from '@opentelemetry/api-logs'
import { ExportResultCode, type ExportResult } from '@opentelemetry/core'
import type { OTLPExporterNodeConfigBase } from '@opentelemetry/otlp-exporter-base'
import { JsonLogsSerializer } from '@opentelemetry/otlp-transformer'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchLogRecordProcessor, LoggerProvider, type BatchLogRecordProcessorOptions, type LogRecordExporter, type ReadableLogRecord } from '@opentelemetry/sdk-logs'
import { createLogExporter } from './transport.ts'

/** Collector request ceiling in uncompressed UTF-8 bytes, including the OTLP envelope. */
export const SESSION_LOG_MAX_REQUEST_BYTES = 4_000_000

/** One canonical event with its separately owned Session identity and redacted payload. */
export interface SessionLogRecord {
  sessionId: SessionId
  /** Complete event envelope; data is the capture policy's exported copy. */
  event: Omit<SessionEvent, 'data'> & { data: unknown }
  /** Additional capture metadata; sessionId and content are always assigned by the reporter. */
  attributes?: Attributes
  /** Omitted values use INFO. */
  severityNumber?: SeverityNumber
}

/** Independent Session-log transport and queue settings. */
export interface SessionLogOptions {
  /** Explicit destination and SDK transport options. */
  exporter: OTLPExporterNodeConfigBase & {
    /** Full HTTP(S) logs destination. */
    url: string
  }
  /** Session-only queue settings, independent of product-event aggregation. */
  processor?: Omit<BatchLogRecordProcessorOptions, 'exporter'>
  /** May lower, but never exceed, the collector's 4,000,000-byte limit. */
  maxRequestBytes?: number
  /** Application and anonymous identity carried on the OTLP resource. */
  resourceAttributes: Attributes
  /** Report rejected single records and network failures without recording their content. */
  onFailure: (message: string, error?: Error) => void
}

/**
 * Validate byte and queue settings before constructing an SDK pipeline.
 * @param options - Session-specific limits supplied by the owning composition.
 * @returns the resolved collector request limit.
 */
export function resolveSessionLogLimits(options: Pick<SessionLogOptions, 'maxRequestBytes' | 'processor'>): number {
  const limit = options.maxRequestBytes ?? SESSION_LOG_MAX_REQUEST_BYTES
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SESSION_LOG_MAX_REQUEST_BYTES) {
    throw new Error(`session log maxRequestBytes must be an integer between 1 and ${SESSION_LOG_MAX_REQUEST_BYTES}`)
  }
  for (const key of ['maxQueueSize', 'maxExportBatchSize', 'scheduledDelayMillis', 'exportTimeoutMillis'] as const) {
    const value = options.processor?.[key]
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)) {
      throw new Error(`session log processor.${key} must be a positive integer no greater than 2147483647`)
    }
  }
  return limit
}

/** Split SDK batches using the same JSON serializer as the HTTP exporter. */
class ByteBoundedExporter implements LogRecordExporter {
  private readonly pending = new Set<Promise<ExportResult>>()

  constructor(private readonly exporter: LogRecordExporter, private readonly limit: number, private readonly warn: SessionLogOptions['onFailure']) {}

  export(records: ReadableLogRecord[], callback: (result: ExportResult) => void): void {
    const pending = this.send(records)
    this.pending.add(pending)
    void pending.then((result) => {
      this.pending.delete(pending)
      callback(result)
    }, (error: unknown) => {
      this.pending.delete(pending)
      callback({ code: ExportResultCode.FAILED, error: error instanceof Error ? error : new Error(String(error)) })
    })
  }

  private async send(records: ReadableLogRecord[]): Promise<ExportResult> {
    const serialized = JsonLogsSerializer.serializeRequest(records)
    if (serialized === undefined) throw new Error('Session log serialization produced no request')
    const bytes = serialized.byteLength
    if (bytes <= this.limit) {
      return new Promise((resolve) => { this.exporter.export(records, resolve) })
    }
    if (records.length === 1) {
      const error = new Error(`Session log record exceeds maxRequestBytes: ${bytes} > ${this.limit}`)
      this.warn('Session log record rejected; content was not truncated', error)
      return { code: ExportResultCode.FAILED, error }
    }
    const middle = Math.ceil(records.length / 2)
    const first = await this.send(records.slice(0, middle))
    const second = await this.send(records.slice(middle))
    return first.code === ExportResultCode.FAILED ? first : second
  }

  async forceFlush(): Promise<void> {
    await this.exporter.forceFlush()
    await Promise.all(this.pending)
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.pending)
    await this.exporter.shutdown()
  }
}

/** Owns a Session-only queue; callers must drain it during their bounded shutdown. */
export class SessionLogReporter {
  private readonly provider: LoggerProvider
  private readonly logger: ReturnType<LoggerProvider['getLogger']>

  /**
   * @param options - transport, resource identity, queue limits, and failure observer.
   */
  constructor(options: SessionLogOptions) {
    const limit = resolveSessionLogLimits(options)
    const exporter = new ByteBoundedExporter(createLogExporter(options.exporter), limit, options.onFailure)
    this.provider = new LoggerProvider({
      // Session content must not be truncated by ambient SDK attribute limits.
      logRecordLimits: { attributeValueLengthLimit: Infinity, attributeCountLimit: Infinity },
      resource: resourceFromAttributes(options.resourceAttributes),
      processors: [new BatchLogRecordProcessor({
        ...options.processor,
        exporter: {
          export: (records, callback) => {
            exporter.export(records, (result) => {
              if (result.code !== ExportResultCode.SUCCESS) options.onFailure('Session log export failed', result.error)
              callback(result)
            })
          },
          forceFlush: () => exporter.forceFlush(),
          shutdown: () => exporter.shutdown(),
        },
      })],
    })
    this.logger = this.provider.getLogger('@deepseek-ai/dsh-session-telemetry-otel')
  }

  /**
   * Enqueue one event as a string-valued session-log record without acknowledging delivery.
   * Oversized records are rejected during export; other records continue independently.
   * @param record - canonical event and the Session it belongs to.
   */
  reportSessionLog(record: SessionLogRecord): void {
    const severityNumber = record.severityNumber ?? SeverityNumber.INFO
    this.logger.emit({
      eventName: 'session-log',
      body: 'session-log',
      timestamp: record.event.time,
      observedTimestamp: record.event.time,
      severityNumber,
      severityText: SeverityNumber[severityNumber],
      attributes: { ...record.attributes, sessionId: record.sessionId, content: JSON.stringify(record.event) },
    })
  }

  /**
   * Drain accepted records and stop the SDK pipeline; the owner supplies an outer deadline.
   * @returns resolves when SDK shutdown completes, without guaranteeing collector acceptance.
   */
  shutdown(): Promise<void> { return this.provider.shutdown() }
}
