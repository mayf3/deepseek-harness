# 产品埋点

[English](product-telemetry.md) | 中文

[产品埋点插件](../../packages/host/product-telemetry-otel/README.zh.md) 通过 OTLP/HTTP 发送明确选定的分析事件。`productTelemetry` 服务仅负责提交；产品消费方决定事件发生时机与获准采集的字段。不自动采集 Session 数据或标识。

`ProductTelemetryRecord` 要求事件名称、字符串 body 和 Unix 毫秒时间戳。属性接受字符串、数字、布尔标量，以及这些值组成的单层对象（`ProductTelemetryScalar`）。可选的严重程度使用 OTel 严重程度数字，默认为 INFO。记录入队时填写观测时间。

入队同步完成，不代表送达确认。SDK 负责批量发送与重试；发送失败会产生本地诊断。配置、退出和丢失限制见包 README。

`reportSessionLog()` 将一条完整 Session 事件作为 `eventName: "session-log"` 提交，字符串属性为 `sessionId` 和 `content`。`SessionLogReporter` 向反馈后端提供同一个独立排队的发送器。发送器在 gzip 前计量完整 OTLP JSON 字节数，按 4,000,000 字节或更低配置上限拆分请求，并拒绝超限单条事件而不截断。

## 记录类型

```ts type-equiv
/** Scalar values accepted by the collector's Arrow attributes map. */
type ProductTelemetryScalar = string | number | boolean
```

```ts type-equiv
/** Explicitly selected analytics fields; object values may contain scalars only. */
interface ProductTelemetryRecord {
  /** Product/DA-owned event name. */
  eventName: string
  /** Human-readable summary; never a prompt, response, credential, or file contents. */
  body: string
  /** Event occurrence time in Unix milliseconds. Observation time is assigned on enqueue. */
  timestamp: number
  /** OTel severity; omitted values use INFO. */
  severityNumber?: SeverityNumber
  /** Business fields selected by the caller; no automatic device or account identity. */
  attributes?: Record<string, ProductTelemetryScalar | Record<string, ProductTelemetryScalar>>
}
```

Source: [`packages/host/product-telemetry-otel/src/index.ts`](../../packages/host/product-telemetry-otel/src/index.ts)

```ts type-equiv
/** One canonical event with its separately owned Session identity and redacted payload. */
interface SessionLogRecord {
  sessionId: SessionId
  /** Complete event envelope; data is the capture policy's exported copy. */
  event: Omit<SessionEvent, 'data'> & { data: unknown }
  /** Additional capture metadata; sessionId and content are always assigned by the reporter. */
  attributes?: Attributes
  /** Omitted values use INFO. */
  severityNumber?: SeverityNumber
}
```

```ts type-equiv
/** Independent Session-log transport and queue settings. */
interface SessionLogOptions {
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
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxproducttelemetry--producttelemetry"></a>

### `ctx.productTelemetry` — `ProductTelemetry`

Host analytics sender. Mounting alone sends nothing; the owning fiber drains it on unload.

```ts cordis-catalog
/**
 * Enqueue one explicitly authorized Session event in the separate byte-bounded queue.
 * Queue admission and shutdown completion are not collector or warehouse acknowledgements.
 * @param record - complete Session event and its owning Session id.
 */
reportSessionLog(record: SessionLogRecord): void

/**
 * Enqueue a selected product event independently of Session-log reporting.
 * @param record - approved analytics fields; no automatic Session collection.
 */
emit(record: ProductTelemetryRecord): void
```

Source: [`packages/host/product-telemetry-otel/src/index.ts`](../../packages/host/product-telemetry-otel/src/index.ts)
<!-- END GENERATED cordis-surface -->
