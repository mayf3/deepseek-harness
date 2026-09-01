/**
 * OpenTelemetry Service Provider for the DeepSeek Harness telemetry capability.
 *
 * Composes the OTel JS SDK as-is — a `LoggerProvider` with a
 * `BatchLogRecordProcessor` and an OTLP/HTTP log exporter — and maps each
 * record handed over by the capture coordinator onto `logger.emit()`. After that call,
 * batching, retry, queueing, and loss policy use the SDK's documented behavior, configured
 * verbatim through the `exporter`/`processor` passthroughs. This package owns
 * capture mode and an outer shutdown deadline: the SDK's export timeout does
 * not bound its preceding `forceFlush()` wait.
 *
 * @module @deepseek-ai/dsh-session-telemetry-otel
 */

import { createRequire } from 'node:module'
import { gzipSync } from 'node:zlib'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-command-feedback'
import {
  SessionTelemetryBackend,
  SessionTelemetryCoordinator,
  type SessionTelemetrySink,
  type SessionTelemetryRecord,
  type SessionTelemetrySeverity,
  type SessionTelemetrySharingStatus,
} from '@deepseek-ai/dsh-session-telemetry'
import { APP_IDENTITY } from '@deepseek-ai/dsh-llm'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  type BatchLogRecordProcessorOptions,
} from '@opentelemetry/sdk-logs'
import { OTLPExporterBase } from '@opentelemetry/otlp-exporter-base'
import { createLegacyOtlpBrowserExportDelegate } from '@opentelemetry/otlp-exporter-base/browser-http'
import { JsonLogsSerializer } from '@opentelemetry/otlp-transformer'
import type { ISerializer } from '@opentelemetry/otlp-transformer'
import type { OTLPExporterConfigBase } from '@opentelemetry/otlp-exporter-base'
import type { ReadableLogRecord } from '@opentelemetry/sdk-logs'
import { SeverityNumber, type AnyValue, type Logger } from '@opentelemetry/api-logs'
import { resourceFromAttributes } from '@opentelemetry/resources'

// The package's own manifest is the single source of the instrumentation-scope
// version (same pattern as dsh-llm's attribution identity).
const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

/** Session-sharing policy selected by {@link Config.mode}. */
export enum SessionTelemetryMode {
  FULL = 'FULL',
  FEEDBACK_ONLY = 'FEEDBACK_ONLY',
  DISABLED = 'DISABLED',
}

/** Default session-sharing policy for schema and direct construction. */
export const DEFAULT_TELEMETRY_MODE = SessionTelemetryMode.DISABLED

const DISABLED_FEEDBACK_WARNING = 'session telemetry is DISABLED; nothing will be shared and this feedback remains local'
const NON_CANONICAL_FEEDBACK_WARNING = 'session telemetry ignored a feedback event absent from the canonical session log'
const DROP_RECORD: SessionTelemetrySink['emit'] = () => {}

/** Resolve the default and reject unknown runtime values before transport setup. */
function resolveMode(mode: SessionTelemetryMode | undefined): SessionTelemetryMode {
  const resolved = mode ?? DEFAULT_TELEMETRY_MODE
  switch (resolved) {
    case SessionTelemetryMode.FULL:
    case SessionTelemetryMode.FEEDBACK_ONLY:
    case SessionTelemetryMode.DISABLED:
      return resolved
    default:
      return assertNever(resolved)
  }
}

/** Fail closed when direct construction bypasses the runtime config schema. */
function assertNever(value: never): never {
  throw new Error(`session-telemetry-otel: unsupported mode ${JSON.stringify(value)}`)
}

/** Map the serialized mode onto the seam's backend-independent sharing vocabulary. */
function sharingStatusFor(mode: SessionTelemetryMode): SessionTelemetrySharingStatus {
  switch (mode) {
    case SessionTelemetryMode.FULL: return 'full'
    case SessionTelemetryMode.FEEDBACK_ONLY: return 'feedback-only'
    case SessionTelemetryMode.DISABLED: return 'disabled'
    /* v8 ignore next 2 -- resolveMode already rejected unknown values before this switch; the closed enum cannot reach the default. */
    default: return assertNever(mode)
  }
}

/**
 * Plugin configuration: one sharing policy, two verbatim SDK option objects,
 * and one DSH-owned shutdown bound. Uploading modes validate their endpoint
 * and shutdown deadline at plugin load; `DISABLED` reads neither.
 */
export interface Config {
  /** Sharing policy; defaults to local-only `DISABLED` behavior. */
  mode?: SessionTelemetryMode
  /**
   * Passed verbatim to the SDK's OTLP/HTTP log exporter — the complete
   * `OTLPExporterConfigBase` shape (`headers`, `timeoutMillis`,
   * `concurrencyLimit`, …), owned and documented by the SDK. `url` is the
   * one field this package requires and validates itself.
   *
   * The transport is the SDK's `fetch` one, so `keepAlive` and
   * `httpAgentOptions` — which configure its `node:http` transport — are
   * refused at load rather than ignored. `compression` is honored by this
   * package instead of by that transport.
   */
  exporter?: OTLPExporterConfigBase & {
    /** Full logs endpoint (e.g. `https://collector.example.com/v1/logs`). Required outside `DISABLED`; validated at load. */
    url?: string
    /** Request body compression, applied by this package rather than by the SDK transport. @default 'none' */
    compression?: SupportedCompression
  }
  /**
   * Passed verbatim to `BatchLogRecordProcessor` (minus the exporter slot,
   * which this plugin fills); the SDK owns and documents these knobs.
   */
  processor?: Omit<BatchLogRecordProcessorOptions, 'exporter'>
  /** Maximum time spent awaiting the SDK provider's complete shutdown path. */
  shutdownTimeoutMillis?: number
}

/**
 * Schemastery validator for {@link Config}; cordis runs it before the plugin
 * starts. It checks only the top-level fields; value checks live in the constructor
 * so their errors name the fields. Both SDK option objects pass through unchanged:
 * the SDK defines and validates their fields. Re-declaring them here would
 * silently drop every field this plugin did not repeat.
 */
export const Config: z<Config> = z.object({
  mode: z.union(Object.values(SessionTelemetryMode)).default(DEFAULT_TELEMETRY_MODE),
  exporter: z.any(),
  processor: z.any(),
  shutdownTimeoutMillis: z.number(),
})

/** Default outer allowance for the SDK's complete shutdown sequence. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MILLIS = 3_000

// Node clamps larger timer delays to one millisecond. This is a runtime
// protocol limit, not a deployment default.
const MAX_TIMER_DELAY_MILLIS = 2_147_483_647

/**
 * Exporter options the SDK defines only for its `node:http` transport. They reach the `fetch`
 * transport this package uses, which silently ignores every one of them.
 */
const NODE_TRANSPORT_ONLY_EXPORTER_OPTIONS = ['keepAlive', 'httpAgentOptions'] as const

/** The one encoding {@link gzipSerializer} applies, spelled as the OTLP `Content-Encoding` spells it. */
const GZIP = 'gzip'

/**
 * Request body encodings this package applies. Narrower than the SDK's `CompressionAlgorithm`,
 * which also spells `deflate`: the `fetch` transport offers no seam to apply that one.
 */
export type SupportedCompression = 'gzip' | 'none'

/** {@link SupportedCompression} as values, for the load-time check on a configuration typed `any`. */
const SUPPORTED_COMPRESSION: readonly string[] = [GZIP, 'none'] satisfies SupportedCompression[]

/**
 * Wrap a serializer so every batch it produces is gzipped.
 *
 * The SDK compresses in its `node:http` transport, which the `fetch` transport this package uses
 * does not have; serialization is the one seam before the body reaches that transport. The shipped
 * profile enables gzip, and a realistic batch measures over six times smaller with it, so dropping
 * compression to gain proxy support would trade one deployment's problem for every deployment's.
 *
 * `gzipSync` runs on the export path, but a batch is bounded by `maxExportBatchSize` and exports are
 * already off the request path — the batch processor schedules them.
 *
 * @param serializer - the SDK serializer producing the uncompressed request body.
 * @returns a serializer producing the gzipped body, deserializing responses unchanged.
 */
function gzipSerializer<Request, Response>(serializer: ISerializer<Request, Response>): ISerializer<Request, Response> {
  return {
    ...serializer,
    serializeRequest: (request) => {
      const serialized = serializer.serializeRequest(request)
      // The SDK returns nothing for a batch it could not serialize. Gzipping that would post an
      // empty frame the collector accepts as a valid, empty export.
      return serialized === undefined ? undefined : gzipSync(serialized)
    },
  }
}

/** Severity mapping from the Service Definition's three-level vocabulary to OTel severity numbers. */
const SEVERITY: Record<SessionTelemetrySeverity, { severityNumber: SeverityNumber; severityText: string }> = {
  info: { severityNumber: SeverityNumber.INFO, severityText: 'INFO' },
  warn: { severityNumber: SeverityNumber.WARN, severityText: 'WARN' },
  error: { severityNumber: SeverityNumber.ERROR, severityText: 'ERROR' },
}

/**
 * The backend plugin — the only entry a deployment loads. It always registers
 * the `telemetry` service (duplicate load throws). Uploading modes wire the SDK
 * pipeline and compose {@link SessionTelemetryCoordinator}; `DISABLED` constructs no
 * SDK state and listens only to warn when recorded feedback stays local.
 */
export class OpenTelemetrySessionBackend extends SessionTelemetryBackend {
  static inject = ['sessions']
  static Config = Config

  private readonly directEmit: SessionTelemetrySink['emit']
  private readonly provider: LoggerProvider | undefined
  private readonly shutdownTimeoutMillis: number
  override readonly sharing: SessionTelemetrySharingStatus

  constructor(ctx: Context, config: Config) {
    const mode = resolveMode(config.mode)
    super(ctx)
    this.sharing = sharingStatusFor(mode)
    if (mode === SessionTelemetryMode.DISABLED) {
      this.directEmit = DROP_RECORD
      this.provider = undefined
      this.shutdownTimeoutMillis = DEFAULT_SHUTDOWN_TIMEOUT_MILLIS
      ctx.on('session/event', (_session, event) => {
        if (event.type === 'feedback/record') ctx.logger.warn(DISABLED_FEEDBACK_WARNING)
      })
      return
    }

    const exporter = config.exporter ?? {}
    const url = exporter.url
    if (url === undefined || url.length === 0) {
      throw new Error('session-telemetry-otel: exporter.url is required (the full OTLP logs endpoint)')
    }
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      // Re-thrown as a config error: the only way here is a malformed url string.
      throw new Error(`session-telemetry-otel: exporter.url is not a valid URL: ${JSON.stringify(url)}`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`session-telemetry-otel: exporter.url must be http(s), got ${parsed.protocol}`)
    }
    // `keepAlive` and `httpAgentOptions` configure the SDK's `node:http` transport, which this
    // package does not use — the `fetch` transport is what reaches a configured proxy. The exporter
    // would accept and ignore them, so a deployment would believe it had tuned a connection it had
    // not. `compression` is the third such option and is honored instead of refused, below.
    const nodeOnly = NODE_TRANSPORT_ONLY_EXPORTER_OPTIONS.filter(name => name in exporter)
    if (nodeOnly.length > 0) {
      throw new Error(`session-telemetry-otel: exporter.${nodeOnly.join(', exporter.')} not supported: telemetry is exported through fetch, whose connections Node owns; ${nodeOnly.length === 1 ? 'that option belongs' : 'those options belong'} to the node:http transport this package no longer builds an agent for`)
    }
    // Compared as strings because that is what arrives: the schema validates this object as `any`,
    // so a cordis.yml may name any algorithm, including one the SDK's enum does not spell.
    const compression: string = exporter.compression ?? 'none'
    if (!SUPPORTED_COMPRESSION.includes(compression)) {
      throw new Error(`session-telemetry-otel: exporter.compression must be one of ${SUPPORTED_COMPRESSION.map(value => JSON.stringify(value)).join(', ')}, got ${JSON.stringify(compression)}`)
    }
    // The one processor field checked beyond the SDK's own validation: the
    // SDK accepts a non-positive batch size, but its shutdown drain then
    // splices empty batches without consuming the queue — dispose would hang
    // forever with records queued. Misconfiguration fails at load instead.
    const batchSize = config.processor?.maxExportBatchSize
    if (batchSize !== undefined && (!Number.isInteger(batchSize) || batchSize < 1)) {
      throw new Error(`session-telemetry-otel: processor.maxExportBatchSize must be a positive integer, got ${String(batchSize)}`)
    }
    const shutdownTimeoutMillis = config.shutdownTimeoutMillis ?? DEFAULT_SHUTDOWN_TIMEOUT_MILLIS
    if (!Number.isFinite(shutdownTimeoutMillis) || shutdownTimeoutMillis <= 0 || shutdownTimeoutMillis > MAX_TIMER_DELAY_MILLIS) {
      throw new Error(`session-telemetry-otel: shutdownTimeoutMillis must be a positive finite number no greater than ${MAX_TIMER_DELAY_MILLIS}, got ${String(shutdownTimeoutMillis)}`)
    }
    this.shutdownTimeoutMillis = shutdownTimeoutMillis
    this.provider = new LoggerProvider({
      resource: resourceFromAttributes({
        'service.name': APP_IDENTITY.product,
        'service.version': APP_IDENTITY.version,
        // OTel semconv's standard user attribute, carried once per export
        // batch on the Resource rather than per record: the collector
        // aggregates by Resource, and the id is process-stable anyway.
        'user.id': getOrCreateAnonymousUserId(),
      }),
      processors: [
        new BatchLogRecordProcessor({
          ...config.processor,
          // The complete validated exporter object, verbatim: every SDK
          // option (`timeoutMillis`, `compression`, `keepAlive`, …) reaches
          // the exporter — rebuilding selected fields here would silently
          // ignore the rest. App identity travels in the Resource
          // (service.name/version); the transport-level user-agent is the
          // SDK's own, per the axiom.
          //
          // The delegate is the SDK's `fetch` one rather than its Node `node:http` one. Both are
          // published entry points of the same package; the `fetch` transport reaches undici's
          // global dispatcher, so a configured proxy carries telemetry with no proxy-aware code
          // here and with no Node-version floor. The Node transport would need an `http.Agent`,
          // and Node only learned to route one from the environment in 22.21 and 24.5.
          //
          // What that costs: `compression` is a Node-transport option and has no effect here.
          //
          // The delegate is deprecated in favour of `createOtlpFetchExportDelegate`, which the SDK
          // exports from no public subpath at 0.220 — this legacy wrapper is the only supported way
          // to reach it, and does nothing but call it. Composing the public
          // `createOtlpNetworkExportDelegate` instead would mean owning the fetch transport and its
          // retry wrapper, both SDK-internal.
          exporter: new OTLPExporterBase<ReadableLogRecord[]>(
            // oxlint-disable-next-line typescript/no-deprecated -- the SDK exports its replacement from no public subpath at 0.220.
            createLegacyOtlpBrowserExportDelegate(
              exporter,
              compression === GZIP ? gzipSerializer(JsonLogsSerializer) : JsonLogsSerializer,
              'v1/logs',
              {
                'Content-Type': 'application/json',
                ...compression === GZIP ? { 'Content-Encoding': GZIP } : {},
              },
            ),
          ),
        }),
      ],
    })
    const ledger = this.provider.getLogger('@deepseek-ai/dsh-session-telemetry-otel', version)
    const ops = this.provider.getLogger('@deepseek-ai/dsh-session-telemetry-otel/ops', version)
    const enqueue: SessionTelemetrySink['emit'] = (record) => {
      const logger: Logger = record.channel === 'ops' ? ops : ledger
      logger.emit({
        timestamp: record.time,
        observedTimestamp: record.time,
        ...SEVERITY[record.severity],
        // JSON-serializable by the seam's contract (validated at Session.append),
        // which is exactly the AnyValue subset.
        body: record.body as AnyValue,
        attributes: record.attributes,
      })
    }
    const backend: SessionTelemetrySink = {
      emit: enqueue,
      shutdown: () => this.shutdown(),
    }
    if (mode === SessionTelemetryMode.FULL) {
      this.directEmit = enqueue
      new SessionTelemetryCoordinator(ctx, backend, 'live')
      return
    }
    this.directEmit = DROP_RECORD
    const coordinator = new SessionTelemetryCoordinator(ctx, backend, 'on-demand')
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'feedback/record') return
      // Consent is the committed record, not an independently emitted bus value.
      if (session.eventAt(event.seq) !== event) {
        ctx.logger.warn(NON_CANONICAL_FEEDBACK_WARNING)
        return
      }
      coordinator.captureSession(session, event.seq)
    })
  }

  /**
   * Hand a direct service record to the SDK only in `FULL`. Direct calls are
   * no-ops in `FEEDBACK_ONLY` and `DISABLED`; feedback replay uses a private
   * backend capability created only for the canonical feedback listener.
   * @param record - the logical record offered directly to the service.
   */
  emit(record: SessionTelemetryRecord): void {
    this.directEmit(record)
  }

  // The Service Definition's optional flush() hint is deliberately NOT implemented. The
  // batch processor exports on its own cadence (`processor.scheduledDelayMillis`,
  // the SDK's documented knob), and this backend is the SDK pipeline's only
  // caller — forwarding the hint to `forceFlush()` would be the sole source of
  // concurrent flushes, whose undocumented interactions with shutdown's
  // internal drain (concurrent-flush guard, provider-level flush timeout)
  // silently drop tail records. Rationale and the revival trigger: the
  // revival Agent Note.

  /**
   * Ask the SDK to drain and quiesce, but reject after the backend-owned
   * deadline. OTel's processor export timeout wraps `exportCompleted` only;
   * shutdown awaits `exporter.forceFlush()` first, which can remain pending
   * when the transport never obtains a socket. The provider promise remains
   * observed after the deadline so a later rejection cannot become unhandled.
   * `DISABLED` has no provider and resolves immediately.
   * @returns resolves when the SDK pipeline quiesces or is disabled, or rejects at the configured deadline.
   */
  async shutdown(): Promise<void> {
    if (this.provider === undefined) return
    const providerShutdown = this.provider.shutdown()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`session-telemetry-otel: provider shutdown exceeded ${this.shutdownTimeoutMillis}ms`))
      }, this.shutdownTimeoutMillis)
    })
    try {
      await Promise.race([providerShutdown, deadline])
    } finally {
      /* v8 ignore else -- the Promise executor assigns timer synchronously before this race starts. */
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

export default OpenTelemetrySessionBackend
