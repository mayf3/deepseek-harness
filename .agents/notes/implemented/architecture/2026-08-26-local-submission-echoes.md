# Agent Note: Local submission echoes over the prompt rpcId

Status: implemented

English | [中文](2026-08-26-local-submission-echoes.zh.md)

## Problem

A multi-image prompt spent seconds in client serialization plus host admission before its durable `user/message` existed, and the conversation showed nothing until then: the composer froze read-only, the message appeared only after the full pipeline, and the user could not tell whether the submission had started (#3003). The durable event cannot move earlier — Model-visible ⟺ logged requires the `user/message` to land only after every attachment persists — so the visible submission had to decouple from the durable one.

## Decision

**The Session object owns a client-local submission echo, correlated by the prompt's existing `requestId`/`rpcId`.** `session.beginSubmission` synchronously inserts `{requestId, text, images: previews}` into `SessionSnapshot.pendingSubmissions` and flips `promptAttempted`, before the caller serializes anything; the same `requestId` rides the prompt RPC. No new correlation id, no wire-type change, and no session-log change: the host already stamps the prompt's `requestId` into the durable user source as `rpcId`, and the queue projection now carries it as `SessionQueuedItem.rpcId` for prompts that land in the inbox instead of the log (running-turn submissions).

**Retirement is observation-driven with a one-frame delay; display dedupe is render-time and declarative.** The Session marks an echo observed when a durable `user/message` or queue occurrence with its rpcId arrives (append, window install, or control frame) and removes it one animation frame later — after the conversation assembly's frame, which was scheduled first. ChatView independently hides any echo whose rpcId appears among rendered user/steering nodes or queue rows, so within every render exactly one of echo/durable is visible regardless of store update order. An identified prompt failure, `abandon()`, or disposal retires the echo immediately as failed; the first settlement wins.

**The composer commits optimistically.** Enter clears the draft, occurrence table, and undo history in one machine transaction and keeps phase `plain`; the send runs as a detached attempt (concurrent sends allowed; the single frozen in-flight slot remains command-only). A failed settlement restores the sent draft, occurrences, and image ids only into a still-empty plain composer — content typed during the flight always wins. Draft images stay registered until the echo retires: failed → available for rail restore; observed → each hands its object URL to `HistoricalImageCache.seed` under the admitted reference (URL ownership and scope-bound revocation move to the cache) so the durable node renders without a byte round-trip or loading flash.

Client image encoding switched from the synchronous chunked-`btoa` loop to `FileReader.readAsDataURL` (native encode). The browser→host transport still ships one base64 JSON envelope; that remaining #2885 transport work is out of scope here.

## Consequences

The submit click paints its message and docks the composer on the same frame, for text and image prompts alike, while admission timing is unchanged. The composer never freezes for default sends, so drafts can be typed and sent during a flight; the machine's `submitting` phase now occurs only for command submissions. A prompt whose RPC response is lost but whose admission succeeded converges through observation instead of double-posting. Echo previews pin the original image blobs until the durable bytes would be fetched anyway; seeded cache entries keep the original (not the normalized) rendition for the session scope's lifetime, which trades some memory for zero-flash replacement.

## Verification

Session client specs pin synchronous insertion, requestId threading, event/queue/window observation, frame-delayed removal, first-settlement-wins, abandon, and disposal. Machine and shell specs pin the optimistic commit, detached settlement, untouched-composer restore, and image-only rail restore. ChatView specs pin flow-tail rendering, node- and queue-keyed dedupe with the echo still in the snapshot, and preview handoff through the message-image slot. Host control specs pin the queue rpcId projection; cache specs pin seed adoption, exclusivity, and scope revocation. The connection fixture echoes `requestId`, so assembled web replays exercise the same retirement.

## Alternatives considered

**A new `clientSubmissionId` threaded through the wire and the user source.** Rejected: `requestId` already exists end-to-end (`user-rpc` source member), so a second id would duplicate the correlation and touch wire validation for nothing.

**Retire the echo synchronously on event ingestion.** Rejected: the chat assembly publishes on an animation frame, so synchronous removal blanks the message for a frame. The steering queue mirror historically accepted that race; the echo path removes it via render-time dedupe plus the delayed retirement.

**Render echoes through the conversation assembler as synthetic nodes.** Rejected: the assembler is driven by durable session events only, and a client-only node kind would widen the closed `ConversationNode` union into every target's `assertNever`; the `PartialAssistant`-style side-channel state matches the existing precedent.

**Keep the composer frozen and only add the echo.** Rejected: the issue's acceptance requires consecutive and concurrent submissions, and a frozen composer reintroduces the perceived hang the echo exists to remove.
