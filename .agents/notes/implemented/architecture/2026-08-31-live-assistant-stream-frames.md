# Agent Note: Live assistant stream frames remain separate from the session log

Status: implemented

English | [中文](2026-08-31-live-assistant-stream-frames.zh.md)

## Problem

The session log keeps every `assistant/chunk` so replay, cold reads, telemetry, and request reconstruction observe one durable v1 history. A live consumer also needs prompt frame-by-frame presentation while a request runs. Treating a transient presentation update as a new durable event would change persistence semantics and make a process-lifetime concern survive restart.

## Decision

`dsh-agent-loop` emits scoped `agent/assistant-stream` frames for each model attempt. `start`, `chunk`, and `end` carry a branded process-local `LlmAttemptId`; every emitted frame advances one Session-local revision. The `start` frame captures a safe-integer wall-clock `startedTime`, chunk indexes are dense from zero, and `end.index` equals the next chunk position. Stream acquisition and its final cancellation check occur before `start`; a failure there emits no frame, while every started attempt emits a terminal `end`. The loop appends every v1 `assistant/chunk` before its matching live chunk frame, records that exact `legacyChunkSeq`, and appends the final `assistant/message` before a committed end frame. The existing authenticated Session-follow accepts an explicit Web opt-in, opens with a cached active-attempt baseline, and carries durable events and cursorless frames in one FIFO. Each follower captures a local arrival ordinal with the opening baseline and drops buffered frames at or before that cut; frame revisions can restart at one with a replacement Agent, so they do not define the opening cut. If the durable opening snapshot precedes the Assistant baseline, a baseline may already acknowledge a chunk whose durable event remains buffered; the Web Session publishes that event when it arrives because the baseline's exact `legacyChunkSeq` proves its matching frame. A final message arriving after an active opening remains staged until the matching `end.index` and ordered provenance arrive; an earlier retry at the same Turn and Step remains visible. Revision, dense-index, or provenance gaps re-open follow and replace the baseline. The TypeScript and Python SDK protocols do not expose these frames. The durable log remains the source of replay and model history.

## Alternatives considered

- **Replace `assistant/chunk` with a live-only stream** — rejected because cold reads, replay, telemetry, and the completed assistant message's source references require the durable raw chunk history.
- **Add a durable assistant-stream event type** — rejected because process-local attempts, revisions, and reconnect presentation are not facts that survive restart or affect model reconstruction.
- **Use an unbranded request string as the attempt key** — rejected because consumers need an opaque identity that cannot be confused with provider request IDs or durable Session IDs.
- **Let UI Chat subscribe to a second live source** — rejected because the Session object owns stream reconciliation and UI Conversation is the sole event-source subscriber; a second source would make settlement order target-dependent.

## Consequences

The Web client renders in-memory chunks before persistence flush while retaining one durable v1 history, without changing `SESSION_FORMAT_VERSION` or the chunk-row encoding. A process restart has no active assistant frames; reconnect and cold replay use durable records. Cursorless notifications never advance the journal cursor, and notifications observed during durable gap repair wait for the replacement page. That page has no Assistant baseline, so the Client clears transient attempts and lets the held notification reopen follow once for an atomically paired page and baseline. The frame declaration remains agent-scoped, so a listener observes only its owning Agent unless it explicitly registers globally.
