# Agent Note: Carry packed chunk rows through session history

Status: implemented

English | [中文](2026-08-15-packed-session-history-transport.zh.md)

## Problem

`session.history` and `subagent.history` serve a bounded logical Session-event interval to remote clients. Provider streams can place hundreds of thousands of token-sized `assistant/chunk` events in one incomplete tail. Expanding every persisted row and then serializing every logical event repeats the same envelope on the wire; expanding every record again in the browser recreates the same object fan-out before the conversation fold joins the text.

The transport must remain lossless. Session sequence numbers are pagination and reconnect evidence; exact token boundaries remain useful to diagnostics and non-UI API consumers; live streaming, durable export, replay, and model-history derivation continue to require the canonical event stream. A server-side transcript projection that discards completed-step chunks would make the API's evidence depend on one UI policy.

## Decision

History methods return `records: HistoryRecord[]` plus inclusive `fromSeq` and exclusive `toSeq` watermarks. An ordinary record carries `{event, view?}`. Consecutive same-block Assistant delta events carry `{chunks: ChunkRow}` using the shared lossless codec from [the packed JSONL decision](2026-07-26-packed-chunk-rows-by-default.md). The page is selected from logical events before packing, so message-aligned pagination remains independent of physical persistence layout.

The wire schema validates every row, rejects unsafe reconstruction, and requires the records to cover `[fromSeq, toSeq)` exactly without gaps or overlaps. The watermarks, not the number or visible seq adjacency of browser fold inputs, own older-page stitching, reconnect repair, and live-event deduplication. `session.history` and `subagent.history` share the same response schema.

The ordinary browser UI does not decode a packed row into one object per token. It coalesces a row into at most two `assistant/chunk` inputs while preserving accumulated content, the first non-empty token timestamp, and a later first non-whitespace visibility timestamp when those boundaries differ. Tool-call rows retain call identity, name presence, joined argument fragments, and first-token timing. Other API consumers may call `decodeStorageRecord()` when exact token boundaries are required.

Live `session/event` frames remain individual events. Session persistence, raw export, replay, model-history derivation, and the canonical in-memory log are unchanged.

## Measured result

A production-sized private session sample was measured without retaining or committing its content. Its tail page contained 416,756 logical events. The lossless packed response used 696 top-level records, including 116 packed rows.

| Representation | Top-level records | JSON bytes | gzip bytes | Brotli bytes |
| --- | ---: | ---: | ---: | ---: |
| Raw logical events | 416,756 | 69,433,638 | 4,190,226 | 1,972,998 |
| Completed-step projection candidate | 228,129 | 38,427,209 | 2,324,688 | 957,350 |
| Lossless packed history | 696 | 6,362,724 | 1,154,206 | 528,145 |

Packing reduced uncompressed JSON by 90.8% relative to raw logical events and by 83.4% relative to the lossy completed-step projection candidate. Brotli output was 73.2% smaller than raw and 44.8% smaller than that projection candidate. These figures describe this sample rather than a protocol guarantee; savings scale with the length and regularity of delta runs.

The opt-in `packages/client/runtime/tests/history-transport.perf.client.ts` benchmark constructs the same logical-event, ordinary-event, and delta-run cardinalities from synthetic content. `DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.perf.config.ts packages/client/runtime/tests/history-transport.perf.client.ts` reports wire sizes, Host/client timing, and sampled additional V8 heap peaks under `HISTORY_TRANSPORT_PERF_RESULT`. Heap measurements force garbage collection before three runs and report the median peak observed after each major Host construction/serialization or Client parse/validation/preparation/fold stage, relative to the same initialized benchmark state. They do not measure process RSS and can miss transients within a sampled stage. The manual performance inventory does not run in CI and carries no machine-dependent timing or memory assertions; structural assertions pin the fixture cardinalities, compact input count, and identical final state from its two-consumer Assistant fold fixture.

## Alternatives considered

**Discard completed-step chunks on the Host.** This lowers logical event count but makes transport semantics depend on the current transcript policy, removes exact evidence from all consumers, and still sends every retained incomplete-step token as a separate envelope. The measured packed response is smaller while remaining lossless.

**Send packed rows and expand every member in the browser.** This removes repeated JSON envelopes on the network but recreates hundreds of thousands of event objects, fold matches, and temporary arrays before producing the same accumulated UI state.

**Rely on HTTP content encoding.** gzip and Brotli reduce bytes on the network but do not remove repeated JSON parsing, validation, allocation, and fold work. Packed rows remain substantially smaller after both encodings in the measured sample.

**Page directly over physical persistence rows.** This could also avoid logical expansion in a cold Host read, but page cuts depend on append-origin messages and replacement provenance rather than backend row boundaries. The current decision keeps the API independent of JSONL, SQLite, and future persistence layouts.

**Return only assembled Assistant snapshots.** The [assembled-messages-only rejection](../../rejected/simplification/2026-06-20-assembled-assistant-messages-only.md) remains applicable: event families outside finalized messages carry user-visible and diagnostic state, and incomplete steps need their actual accumulated chunks.

## Consequences

History responses preserve every logical event while reducing wire bytes, client JSON objects, and ordinary conversation-fold work for long delta runs. Pagination and reconnect logic use explicit raw interval watermarks, so compact browser inputs do not create false gaps. Existing consumers must switch from `events` to the `HistoryRecord` union and choose compact UI folding or exact decoding explicitly.

Cold persisted history is still decoded into the complete logical `SessionEvent[]` before the Host selects and repacks a page. This decision therefore improves transport and browser work, not the Host's cold-read decode memory. Eliminating that expansion requires a persistence-neutral message-boundary index or a separate streaming page reader and remains a distinct optimization.

Historical replay no longer reproduces one UI update per original token. The browser already installs history in a batch rather than animating past tokens; content and timing boundaries used by the settled view remain preserved. Live streaming behavior is unchanged.
