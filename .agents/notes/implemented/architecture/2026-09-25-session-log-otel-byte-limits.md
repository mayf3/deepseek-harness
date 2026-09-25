# Agent Note: Session-log OTLP strings and bounded requests

Status: implemented

English | [中文](2026-09-25-session-log-otel-byte-limits.zh.md)

## Problem

Session logs contain nested JSON and large tool results. The product collector accepts named records with string content and limits request size; count-only SDK batching cannot bound bytes after UTF-8 encoding and JSON escaping.

## Decision

The product OTel package provides one Session-log reporter shared by its service and the feedback backend. Each canonical event becomes `eventName: "session-log"`, with `sessionId` and the JSON-stringified full event in `content` attributes. Redaction applies before serialization; the capture record carries an envelope without a duplicate payload.

Session logs use their own SDK provider and queue. The exporter measures complete uncompressed OTLP JSON using the transport's SDK serializer and splits batches to at most 4,000,000 bytes. A single oversized event is rejected with a diagnostic and does not prevent other events from being sent. Attribute truncation is disabled for this queue. The owner supplies a bounded shutdown that waits for split exports.

The [telemetry revival](../feature/2026-07-23-session-telemetry-otel-revival.md) remains authoritative for redaction, capture, and best-effort handoff. This decision replaces its SDK-only batching rule for Session-log request sizing; the SDK still owns queueing cadence and transport retry. Feedback authorization and the separate DeepSeek model-request contribution remain unchanged.

## Alternatives considered

**One string for the entire Session.** Rejected because one large Session would exceed the request ceiling even when each event fits. One event per record preserves event identity and permits batching.

**Truncate oversized records or add client-only fragments.** Rejected because truncation loses content and fragments require a collector reassembly protocol. Explicit rejection retains the one-event-per-record meaning.

**Count compressed bytes or characters.** Rejected because collector limits can apply after decompression, and characters omit UTF-8 and escaping overhead. Measuring full uncompressed requests gives a conservative bound.

## Consequences

Product and Session records share routing configuration but never a request. Queue overflow, single-event rejection, process exit, and transport failures can still lose data; no durable outbox or collector acknowledgement is added. Tests observe exact byte limits, nested JSON round trips, separated requests, oversize continuation, and feedback-authorized recorded-session replay.
