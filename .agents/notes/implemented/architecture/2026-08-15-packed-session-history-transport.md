# Agent Note: Carry packed chunk rows through session history

Status: implemented

English | [中文](2026-08-15-packed-session-history-transport.zh.md)

## Problem

`session.history` and `subagent.history` serve a bounded logical Session-event interval to remote clients. Provider streams can place hundreds of thousands of token-sized `assistant/chunk` events in one incomplete tail. Expanding every persisted row and then serializing every logical event repeats the same envelope on the wire and makes browser parsing and validation process that repetition before conversation replay can begin.

The transport must remain lossless. Session sequence numbers are pagination and reconnect evidence; exact token boundaries remain useful to diagnostics and non-UI API consumers; live streaming, durable export, replay, and model-history derivation continue to require the canonical event stream. A server-side transcript projection that discards completed-step chunks would make the API's evidence depend on one UI policy.

## Decision

History methods return `records: HistoryRecord[]` plus inclusive `fromSeq` and exclusive `toSeq` watermarks. An ordinary record carries `{event, view?}`. Consecutive same-block Assistant delta events carry `{chunks: ChunkRow}` using the shared lossless codec from [the packed JSONL decision](2026-07-26-packed-chunk-rows-by-default.md). The page is selected from logical events before packing, so message-aligned pagination remains independent of physical persistence layout.

The wire schema validates every row, rejects unsafe reconstruction, and requires the records to cover `[fromSeq, toSeq)` exactly without gaps or overlaps. The watermarks, not the number of transport records, own older-page stitching, reconnect repair, and live-event deduplication. `session.history` and `subagent.history` share the same response schema.

The browser calls the shared `decodeStorageRecord()` codec before handing history to `ConversationNodeAssembler`. Every packed member becomes its exact original `assistant/chunk` event, including `seq`, timestamp, chunk type, block index, text or argument fragment, call identity, and optional-name presence. A registered `ConversationNodeDefinition` therefore receives one `match()` call per historical delta and folds accepted matches with the same start/update sequence it observes for live events. Packing changes transport encoding without changing the public Definition replay semantics.

Live `session/event` frames remain individual events. Session persistence, raw export, replay, model-history derivation, and the canonical in-memory log are unchanged.

## Measured result

A production-sized private session sample was measured without retaining or committing its content. Its tail page contained 416,756 logical events. The lossless packed response used 696 top-level records, including 116 packed rows.

| Representation | Top-level records | JSON bytes | gzip bytes | Brotli bytes |
| --- | ---: | ---: | ---: | ---: |
| Raw logical events | 416,756 | 69,433,638 | 4,190,226 | 1,972,998 |
| Completed-step projection candidate | 228,129 | 38,427,209 | 2,324,688 | 957,350 |
| Lossless packed history | 696 | 6,362,724 | 1,154,206 | 528,145 |

Packing reduced uncompressed JSON by 90.8% relative to raw logical events and by 83.4% relative to the lossy completed-step projection candidate. Brotli output was 73.2% smaller than raw and 44.8% smaller than that projection candidate. These figures describe this sample rather than a protocol guarantee; savings scale with the length and regularity of delta runs.

The opt-in `packages/client/runtime/tests/history-transport.perf.client.ts` benchmark constructs the same logical-event, ordinary-event, and delta-run cardinalities from synthetic content. `DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.perf.config.ts packages/client/runtime/tests/history-transport.perf.client.ts` reports wire sizes, Host/client timing, uncompressed chunked Node loopback transfer medians, combined synthetic API-wait/UI-ready timing, and sampled additional V8 heap peaks under `HISTORY_TRANSPORT_PERF_RESULT`; a second inventory reports the median of five exact decodes for 10,000-, 20,000-, and 40,000-member whitespace-prefix runs under `HISTORY_WHITESPACE_PREFIX_PERF_RESULT`. The combined timing starts from an in-memory event array and omits cold persistence reads, projection and presenter work, the production API bridge and RPC envelope, and Chromium scheduling, so it is comparative inventory rather than production wall-clock latency. Heap measurements force garbage collection before three runs and report the median peak observed after each major Host construction/serialization or Client parse/validation/decoding/fold stage, relative to the same initialized benchmark state; they do not measure process RSS, external or ArrayBuffer memory, or transients within a sampled stage. The manual performance inventory does not run in CI and carries no machine-dependent timing or memory assertions; structural assertions pin the fixture cardinalities, exact decoded event count, and identical final state—including delta count and last-delta sequence—from its two-consumer Assistant fold fixture.

## Alternatives considered

**Discard completed-step chunks on the Host.** This lowers logical event count but makes transport semantics depend on the current transcript policy, removes exact evidence from all consumers, and still sends every retained incomplete-step token as a separate envelope. The measured packed response is smaller while remaining lossless.

**Coalesce a packed run before registered Definitions see it.** This reduces browser event objects and fold calls, but an open `ConversationNodeDefinition` may count deltas, inspect their individual `seq` or timestamps, or derive state from fragment boundaries. Equal accumulated text does not make those state machines equivalent, so the transport cannot change their replay input cardinality.

**Rely on HTTP content encoding.** gzip and Brotli reduce bytes on the network but do not remove repeated JSON parsing and validation. Packed rows remain substantially smaller after both encodings in the measured sample, while exact browser replay retains the required allocation and fold work.

**Page directly over physical persistence rows.** This could also avoid logical expansion in a cold Host read, but page cuts depend on append-origin messages and replacement provenance rather than backend row boundaries. The current decision keeps the API independent of JSONL, SQLite, and future persistence layouts.

**Return only assembled Assistant snapshots.** The [assembled-messages-only rejection](../../rejected/simplification/2026-06-20-assembled-assistant-messages-only.md) remains applicable: event families outside finalized messages carry user-visible and diagnostic state, and incomplete steps need their actual accumulated chunks.

## Consequences

History responses preserve every logical event while reducing wire bytes, Host response serialization and heap, and browser JSON parsing and validation for long delta runs. Pagination and reconnect logic use explicit raw interval watermarks, so packed transport records do not create false gaps. Existing direct consumers must switch from `events` to the `HistoryRecord` union and decode packed rows before event-level processing.

Cold persisted history is still decoded into the complete logical `SessionEvent[]` before the Host selects and repacks a page. This decision therefore improves transport and browser work, not the Host's cold-read decode memory. Eliminating that expansion requires a persistence-neutral message-boundary index or a separate streaming page reader and remains a distinct optimization.

Browser history replay still allocates and folds one event per original token, so this decision does not reduce Definition match/update count or settled-history heap and may add a small decode-time peak while packed records and expanded events coexist. History installs as one batch rather than animating old tokens; live streaming behavior is unchanged.
