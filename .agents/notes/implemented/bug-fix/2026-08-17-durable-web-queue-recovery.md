# Agent Note: Recover the Web queue from durable Inbox state

Status: implemented

English | [中文](2026-08-17-durable-web-queue-recovery.zh.md)

## Problem

Inbox acceptance records normalized `agent/inbox/spliced` events, but the Web queue used a separate mux baseline built by enumerating live Agents. After a Host process restart, a persisted ordinary Session remained cold until an operation needed its Agent, so the live-only baseline omitted accepted pending messages that were still present in the durable log.

A reconnect-only repair would retain two recovery implementations: one for a live Inbox and one for cold Web reads. The correct owner is the Inbox domain, and the session-projection framework already provides live drive, cold folding, reconnect baselines, and cache restoration.

## Decision

`AgentLoop` registers the standard `inbox` projection whenever the Session projection registry is composed. The projection folds normalized `agent/inbox/spliced` operations from the complete session log into the complete `{ 'next-turn', 'next-step' }` state and exposes that same state as its value. A fork therefore projects pending Inbox operations inherited in its seed, like every other projection. Its schema and `InboxState` type have one definition; message values rely on the existing typed `UserMessage` contract rather than a second runtime message validator.

The projection registry owns both durable reconstruction and live state. Its existing `session/event` drive folds each committed splice before `Session.append()` returns. Each Agent's `ReactLoopInbox` command facade reads that same registry state. Inbox normalizes splice coordinates and checks pending `MessageId` uniqueness before append. It does not traverse `session.events`, copy the folded arrays, or apply the committed transition again. It emits the per-message `inserted`, `discarded`, and `claimed` live notifications owned by its mutations.

The generic session-projection carrier is the only Web transport. It sends higher-seq `session/projection` values, includes the complete values block on history tail pages, folds detached cold logs, and uses the projection cache when valid. There is no Host-owned `queue` projection, placement vocabulary, handoff list, dedicated queue frame, or live-Agent reconnect enumeration.

Each Host connection reset discards every retained projection value and watermark before refreshing queries, including cold Sessions absent from the process-local control baseline. Observable faces retain their identities and subscriptions. A list request from an earlier generation cannot publish values or settle the current request; history and list values from the new generation may therefore establish a lower durable seq without losing to unpersisted state. Clearing at connection reset also preserves fresh list values when the control baseline arrives later.

The client Session binding retains `inbox` in its generic per-session projection store and does not copy it into `SessionSnapshot`. QueueDock reads `next-turn` directly. ChatView reads user-origin `next-step` messages directly and ignores injected context. Claiming removes a pending value through the durable splice; a later `user/message` is rendered through the ordinary conversation projection.

`session.updateQueue` resolves an ordinary cold Session through the shared Agent resolver before mutating its Inbox. A restored pending row therefore remains editable, removable, or steerable after restart, while subagent ownership keeps the same fence as other Agent operations.

No new session event or on-disk format is introduced. The existing splice stream remains the durable source of truth.

## Verification

Inbox tests prove that service creation restores both lists through the registered projection, a direct durable append is immediately visible through the same live cell, a fork projects pending input inherited in its seed, and Inbox mutations reject duplicate pending identities before append. Host projection coverage reads a detached persisted Session with a pending splice, returns `values.inbox` through `session.history`, and proves that no live Agent is required. A separate cold-operation test proves `session.updateQueue` resumes the Session and appends the durable removal splice.

Client coverage pins generic Inbox projection delivery, reconnect invalidation for omitted cold Sessions, both baseline arrival orders, obsolete list request outcomes, higher-seq retention before Session materialization, and the absence of queue state from `SessionSnapshot`. UI coverage pins direct `next-turn` QueueDock rendering and user-origin `next-step` ChatView rendering. The keyless Web fixture opens a cold persisted Session and observes its pending row after restart.

## Alternatives considered

**Add cold Sessions to the old queue reconnect loop.** Rejected because it would duplicate the projection registry's cold fold and preserve separate implementations for live pushes, history, cache, and reconnect.

**Register a Web-specific `queue` projection in Session Controller.** Rejected because pending input belongs to Inbox. Placement rows and a handoff list would introduce a second domain model solely for one client.

**Store a complete Inbox snapshot on every splice event.** Rejected because the durable event is a normalized mutation, not a repeated aggregate. The projection framework owns aggregate reconstruction and checkpointing.

**Reconstruct Inbox in the client from raw session events.** Rejected because pagination may omit the insertion that established current state and every client would duplicate splice semantics.

**Resume every cold Agent while opening the mux stream.** Rejected because displaying durable state must not publish runtime resources, mount presets, or start lifecycle work.

## Consequences

Pending Queue and steering input recover after Host process restart without resuming an Agent. Live Inbox reads, cold history, reconnect, and projection caching use the same domain-owned fold and registry state. Operations on a restored row do resume its ordinary Agent, preserving preset composition and ownership checks.

Clients receive the raw two-list Inbox value and decide which messages their surface presents. Forked sessions project pending Inbox operations present in their inherited seed. The projection state version invalidates cached rows whenever its serialized state or fold semantics change.
