# Agent Note: Session Controller forks exclude the next inbox change

Status: implemented

English | [中文](2026-09-11-session-controller-fork-turn-cut.zh.md)

## Problem

A user input enters the durable inbox before its `turn/start`. Extending a completed-turn fork through the following between-turn events can copy the next input's insertion without its later removal. Continuing the child then executes an input from beyond the selected turn.

## Decision

The [Session Controller](../../../../packages/api/session-controller/README.md) selects a completed `turn/end` and copies its contiguous prefix plus following events up to, but excluding, the first `turn/start` or `agent/inbox/spliced`. Explicit anchors select the first closing event at or after the anchor; omitted and past-end anchors select the last closing event. Both next-turn and next-step inbox changes stop the extension.

This retains title and model-setting events before the first inbox change, consistent with the [log-only event decision](../simplification/2026-07-28-remove-synthetic-log-only-turns.md). The lower-level `SessionStore.fork()` retains its explicit stable-event semantics.

## Alternatives considered

**Stop exactly at the selected turn end.** This drops standalone title and model-setting events recorded after the turn even when no input follows them.

**Copy the tail and clear the child's inbox.** Clearing adds child events to cancel input that the fork can exclude from its seed.

## Consequences

An asynchronous title or plugin event can occur after an inbox change; the fork excludes it along with the rest of that tail. Event ordering does not guarantee that every late plugin result is inherited. The client independently assigns a fork title from the displayed source title when available. Events already inside the selected completed-turn prefix retain their ordinary replay semantics; this decision does not redefine pending input inserted before the selected closing event.

## Verification

Controller tests execute the production loop and check that sending C after forking A excludes the parent's later B from child history and produces one model request, while retaining a title between A's end and B's insertion. Message, closing-event, omitted, and past-end anchors share this assertion. Model-routing coverage retains settings before either inbox destination and excludes later titles and settings. The Web message-actions snapshot places B's inbox insertion between completed turns and verifies the branch action creates a child without B or its insertion.
