---
description: "Configure explicit product usage events, OTLP/HTTP routing, batching, and shutdown limits."
kind: "package-reference"
---

# @deepseek-ai/dsh-product-telemetry-otel

English | [中文](README.zh.md)

## Summary

Send selected product usage events to an OTLP/HTTP collector. Events carry a name, string summary, occurrence time, and scalar or one-level object attributes. Mounting the plugin collects nothing automatically; applications explicitly submit each event. Delivery is best effort and does not confirm warehouse ingestion.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin in a Cordis composition with the application identity; override the collector endpoint when needed. The shipped profiles do not mount it.

```yaml
- name: '@deepseek-ai/dsh-product-telemetry-otel'
  config:
    endpoint: https://dsh-otel-collector.deepseeksvc.com/v1/logs
    serviceName: dsh-telemetry-test
    serviceVersion: test
    compression: gzip
    scheduledDelayMillis: 30000
```

| Field | Default | Meaning |
|---|---|---|
| `endpoint` | `https://dsh-otel-collector.deepseeksvc.com/v1/logs` | Full HTTP(S) logs URL |
| `serviceName`, `serviceVersion` | required | Application identity on the OTel resource |
| `channel` | `dsh_otel_report` | Collector `x-channel` header |
| `compression` | SDK environment | `gzip` or `none`; omission honors OTel compression environment variables |
| `maxExportBatchSize`, `maxQueueSize` | `512`, `2048` | Record-count limits; batch size cannot exceed queue size |
| `scheduledDelayMillis` | `30000` | Partial-batch export interval |
| `timeoutMillis` | `15000` | Exporter HTTP and retry deadline |
| `exportTimeoutMillis` | `20000` | Processor batch export deadline |
| `shutdownTimeoutMillis` | `21000` | Outer wait for shutdown; expiry reports possible loss |

Consumers inject `productTelemetry` and call `emit()` with explicitly selected analytics fields. Event names and field semantics belong to their product and analytics owners. The plugin reads no Session, account, credential, or device identifier. Callers must exclude prompts, responses, file contents, credentials, and other unapproved values.

The collector expects a string body and attributes containing strings, numbers, booleans, or objects of those scalars. Callers supply occurrence time in milliseconds; the plugin assigns observation time and defaults severity to INFO. Invalid transport configuration fails at activation. Export failures produce local warnings without making event submission wait for the network.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

A private OTel logger feeds `BatchLogRecordProcessor` and the HTTP JSON exporter. The SDK owns queueing, transient-error retries, and compression; plugin disposal drains pending records with a bounded wait. Export completion is observed separately because SDK shutdown can resolve after a rejected export. No global OTel provider is installed.

[`src/index.ts`](src/index.ts) owns configuration and submission. No runtime invariant companion is published: delivery has no independent local acknowledgement to compare with the SDK's queue.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Product telemetry](../../../docs/subsystems/product-telemetry.md) — consumer types and service reference.
- [Session telemetry](../../session/session-telemetry-otel/README.md) — separate feedback-authorized Session reporting.
- [Testing policy](../../../docs/testing.md) — Loader composition and network fixtures.

-----

<a id="model-experience"></a>
## Model Experience

None, as the plugin exports explicit analytics records without contributing model context.

#### KV Cache effect

None; event submission does not change model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Delivery and collection remain limited to the following capabilities.

- No business events, renderer transport, or account/device identity are wired automatically.
- The queue is memory-only; overflow, network failure, and process exit can lose events. There is no durable outbox or warehouse acknowledgement.
- The SDK batches by record count, not encoded bytes. Callers must keep records within the collector's 4 MB limit and choose batch sizes appropriate to the receiver.
- Caller-selected strings are not redacted automatically. This package does not decide product disclosure or consent policy.

<a id="dev-note"></a>
### Dev Note

None.
