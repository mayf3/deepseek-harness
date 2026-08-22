# Agent Note: Session history and event transport

Status: implemented

English | [中文](2026-08-18-session-history-and-event-transport.zh.md)

## Problem

The browser Session consumes two data categories with different lifecycles. A durable Session log and its projections must support cold reads while no Agent is attached; queue, approval, question, and jobs state is process-local and authoritative only while the Agent or corresponding wait still exists. The legacy API Proxy mixed both categories in one all-Session mux, where `session/subscribed`, history refetches, and several baselines jointly handled reconnects, so the interface could not reveal whether an observation was allowed to resume an Agent.

Typert's generic `Agent` and `Session` lookups resume an ordinary cold Session. If history, projection, or state subscriptions use those parameters directly, opening a page can resume an Agent; if every operation instead remains cold, prompt, create, and fork cannot perform the activation they explicitly require. Activation policy must belong to each operation rather than arise implicitly from a carrier or parameter type.

Removing the aggregate `session/event` path also creates a list-consistency problem: the old client updated activity ordering from every event it received, while a per-Session `follow` does not cover Sessions that are not open. The list must obtain the latest user-prompt time from a cold-readable domain projection instead of depending on whether one browser follows that log.

## Decision

`packages/api/session-controller` provides `@deepseek-ai/dsh-api-session-controller`. Its Host service mounts as `ctx.sessionController` and generates `ctx.remote.session`; its Client entry consumes unary and stream methods through the API Gateway's shared Remote WebSocket mux. One owner handles Session cold reads, live control, interaction responses, and explicit business commands, while internal agent, commands, control, history, and list controllers retain implementation-level separation.

The API Gateway Client plugin opens `/api/remote.mux` as soon as it activates and keeps the physical WebSocket connected even with no logical streams. The mux recreates the physical connection with capped jittered backoff after an initial connection failure or an established connection loss; logical streams waiting to open share that reconnect loop, while an already-open generated stream terminates with `RemoteStreamCarrierError`. Gateway's `$stream` supervisor reopens only after that carrier failure: it permits one isolated retry against an available Host or waits for the next Host generation, while the Session consumer supplies the latest sequence for follow or requires a replacement baseline for control. Business and protocol failures remain terminal. Client disposal stops backoff, closes candidate and active sockets, and awaits the background loop. In-process `connection.rpc.open` continues to bypass the browser mux.

### Activation policy

Session Remote methods pass a `SessionId` or `SessionAddress` without triggering a generic Typert lookup through the parameter type. `SessionController` distinguishes cold inspection, live-only lookup, and resume-permitted resolution so every endpoint's activation behavior is visible and independently testable. The generic `Agent` and `Session` lookups it configures for other Remote namespaces reuse the same preset, concurrent-resume, and subagent-ownership policy.

| Operation | Source or result without a live Agent | Activation rule |
|---|---|---|
| `session.page(address)` | Read the header and log from persistence | Never resumes an Agent |
| `session.follow(address)` | Inspect persistence, replay the missing suffix, then wait for future commits | Connecting and waiting never resume an Agent; events can appear only after another explicit command activates the Session |
| Projection and Session-list baseline | Recover from durable events or the projection cache | Never resumes an Agent; reading a title does not require an Agent |
| Queue, approval, question, jobs, and live projection in `session.control()` | Observe only attached Agents, pending registries, and process-local registries; absence means empty or unavailable | Subscription, reconnect, and baseline generation never resume an Agent |
| `session.respond`, `updateQueue`, and `cancel` | Reach only a pending item or live Agent that still exists; stale operations return an explicit failure | Never resumes an Agent for live state that has already disappeared |
| Session list, search, attachment, and fork-source reads | Inspect persistence or an attached Session | The read itself never resumes an Agent |
| Explicit Session commands such as prompt, rename, and model changes | Resolve or resume the target according to the command's own policy | Resumes only when the command contract explicitly permits it |
| Create and the fork target | Create a new Session and Agent | The explicit user command authorizes creation; reading the fork source remains cold |

`follow` installs its `session/event` listener before inspecting an attached Session or persistence. It returns the cursor at open time; a reconnect carrying `afterSeq` first replays the missing suffix from the authoritative log, then drains commits buffered during the read in sequence order. A cold Session can therefore open history and follow immediately and remain waiting without attaching an Agent. A physical WebSocket loss resumes from the last applied sequence; Host business and persistence failures arrive as terminal Remote Stream errors and publish as the Session's `openError`, rather than being misclassified as an indefinitely retryable carrier loss.

### Live control stream

`control()` is one Host-wide shared Remote stream that preserves the value of aggregate observation: a browser receives interaction and transient state for every currently live Session without activating those Sessions by opening their transcripts. The Host installs queue, pending-interaction, jobs, projection, and Agent-lifecycle listeners before producing a complete baseline, then drains changes buffered during baseline construction. Every physical reconnect replaces the Client's transient mirror with a new baseline instead of inventing durable sequences for process-local values.

Queue and jobs use complete snapshots with last-wins application. Agent attach, detach, and owner disposal produce a baseline or empty snapshot capable of clearing stale values. Approval and question control frames carry a stable `interactionId`; the opening baseline replays requests that remain pending, resolved frames withdraw requests, and the `respond` Remote unary uses the same identity with the existing outcome or answer semantics. The mechanism preserves first-responder-wins and explicit stale-response failure without the old `RpcRequest<MuxFrame>` envelope.

The projection baseline still accompanies the tail `page` log cut. `control()` pushes only later complete projection values with their watermarks, and the Client merges both sources by retaining the higher sequence. A cold title and other log-derived projections recover through `page` or list reads; subscribing to live projections never starts an Agent to obtain a value. The opened cursor from `follow` replaces `session/subscribed` for the durable log, while the control baseline replaces its responsibility for clearing queue, jobs, and pending-interaction mirrors. The legacy `session/event`, `session/subscribed`, and aggregate event mux consequently have no remaining responsibility.

Session added and removed notifications and Agent running status can recover from a Session-list baseline, while an Agent error without a turn position is an immediate notification that needs neither a response nor replay. These do not enter the stateful control stream; `@deepseek-ai/dsh-api-session-controller` exposes them as client-safe events under the [`ctx.remote.$on`](2026-08-10-remote-event-delivery.md) delivery rules. Observing these events also never resumes an Agent.

### Unified Session Controller ownership

`SessionController` owns the Session BFF formerly housed in API Proxy: list, search, create, models, selectModel, rename, fork, prompt, attachment, updateQueue, cancel, page, follow, control, and respond. It owns preset-aware creation and resumption, the subagent ownership fence, Workspace association, model selection, history reads, and endpoint-specific error projection. Remaining API Proxy domains reuse this identity policy through `ctx.sessionController.inspect()` and `resolveAgent()` instead of retaining a second resolver.

The service selects cold inspection, live-only `ctx.agents.get`, or explicit ensure/resume per endpoint. Queue mutation, cancel, and interaction response can operate only on authoritative objects in the current process even when the user initiates the command; prompt, rename, and model changes explicitly resume according to their own contracts. Internal controllers keep data-channel and command implementations separate, while public ownership and activation policy have one home.

Session create and fork may still call the Workspace registry to establish ownership, while Workspace Remote methods and `host/workspace-*` notifications remain in API Proxy. Workspace migration is not a prerequisite for completing the Session data channel.

### List timing and projections

`@deepseek-ai/dsh-api-session-controller` owns the `sessionListMetadata` projection and the list projection built from it. The state changes `blank` to false at the first `turn/start` and records `lastPromptAt` for each `user/message` whose source is the user; a Session row's `updatedAt` is always `max(header.createdAt, lastPromptAt)`. A cold list recovers this value from the projection cache or durable log, and a live change updates the list through a client-safe `$on` notification, so a Session whose transcript is closed still moves after a new prompt.

`updatedAt` is a derived field of the API Session list. It is neither written to the Session header nor borrowed from the Workspace's own `updatedAt`; Workspace ordering and update times remain owned by the Workspace registry.

## Alternatives considered

**Resume an Agent whenever any Session stream opens.** Viewing history, reading a title, reconnecting a tab, or observing background state would then have execution side effects, and several browsers could trigger redundant resumes. Cold logs and recoverable projections already have persistence sources, so observation has no authority to activate execution.

**Allow `follow` only for a live Agent.** This would force the transcript's first screen to resume an Agent or return to the race between unary history and a separate live stream. Subscribing by identity before a cold read covers both history and events from later explicit activation without activating the Agent itself.

**Publish separate `session-transport` and `api/session` packages.** The data channel and command API are conceptually distinct, but both depend on Session addresses, Agent activation policy, interaction responses, and Client mount order. Splitting them would create cross-package coordination without independently replaceable capabilities. One `SessionController` provides unified public ownership while internal controllers preserve implementation separation and each endpoint declares whether activation is permitted.

**Convert queue, approval, question, jobs, and projection entirely to ordinary `$on` events.** Ordinary events provide no reconnect baseline and cannot express a stable response identity for pending interactions; one lost push would leave state permanently stale. The shared control stream establishes one complete baseline for stateful live data, while lifecycle notifications recoverable by query continue to use `$on`.

**Retain the API Proxy mux.** This avoids migrating existing frames but preserves a hand-written union, schema, response envelope, and second stream lifecycle, preventing API Proxy from leaving the Session data plane.

**Keep deriving list activity from aggregate `session/event` delivery.** List correctness would depend on which Sessions a browser happens to consume and would treat arbitrary plugin events as user activity. `sessionListMetadata.lastPromptAt` directly represents the ordering fact the product needs and can be recovered from cold durable state.

## Verification

Host tests pin that cold `page` and cold `follow` do not add an attached Agent, a cold follow receives contiguous events after an explicit prompt resumes the Session, reconnect replays only missing sequences, and persistence or business failures retain their category and message as terminal errors. Control tests pin listener-before-baseline ordering, no cold-Session resumption, attach and detach cleanup, complete queue and jobs snapshots, stable pending-interaction identities with first-responder-wins, and higher-sequence projection watermarks winning.

Session Controller tests separately pin cold reads, live-only commands, and explicit-resume commands, proving they do not share one implicit activation policy; create and fork cover presets, ownership, and Workspace association. List tests cover one `lastPromptAt → updatedAt` calculation for attached and cold Sessions and prove that a prompt reorders a Session whose transcript is closed. Client tests cover independent follow and control cancellation, replacement of transient mirrors after a control reconnect, and the absence of legacy mux frames from the Session data flow.

## Consequences

The browser can read and follow a durable Session while its Agent is stopped. Observation never implicitly resumes execution; only explicit Session commands activate or create an Agent according to their own contracts. Durable logs repair missing suffixes by sequence, while process-local control state converges from a complete baseline, so the two reconnect strategies no longer imitate each other.

This decision takes ownership of the Session lifecycle, transcript, input control, and stateful streams deferred by [unary API Proxy migration](../../proposed/architecture/2026-08-10-unary-apiproxy-remote-migration.md), and replaces that proposal's direct delegation of `session.rename` to the title service with one `api/session-controller` owner; its other business migrations remain independent. It replaces only the API Proxy carrier from [web background-job display](../feature/2026-08-08-web-background-job-display.md), retaining complete job snapshots, process-local lifecycles, and the rule that observation never resumes an Agent. Workspace remains an explicitly deferred boundary.
