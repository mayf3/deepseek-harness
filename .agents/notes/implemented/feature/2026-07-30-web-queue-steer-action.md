# Agent Note: Steer a queued Web message into the active turn

Status: implemented

English | [中文](2026-07-30-web-queue-steer-action.zh.md)

## Problem

The Web composer originally queued every Enter submission while an agent ran. QueueDock already gives each pending message an addressable row, and the durable transcript already renders consumed steer events as user-style bubbles, but Web had neither an action connecting those two surfaces nor a direct composer gesture for choosing current-turn steering.

Implementing the row action as a client-side delete followed by `session.prompt(mode: 'steer')` would split one user intent across two RPCs. Driver claim could win between them, the steer could fail after deletion, or the existing best-effort `agent.steer()` fallback could silently append a new Queue item after the original occurrence was removed. A send-now action must therefore distinguish current-turn steering from Queue promotion and preserve the original row when steering is no longer possible.

## Decision

### Product contract

Each non-editing ordinary-session QueueDock row exposes the upward-arrow action as “插话发送”. The action is enabled only while the session reports a running agent; mixed-content messages remain eligible because steering forwards the complete immutable `UserMessage` rather than the row's text projection. An addressed subagent keeps its Queue projection read-only because its continuation transport does not expose queue mutation.

Activating the action requests current-turn steering for that exact `MessageId`. Success moves the message from `inbox['next-turn']` to `inbox['next-step']`; QueueDock removes its row and ChatView renders the same pending steering after the `Deep diving...` running-status row, with Copy but no Fork. Once AgentLoop drains it, the durable deletion removes the pending bubble and the existing `user/message` event enters the ordinary conversation-node path with its clock and Copy.

The running bit is both the interaction hint and the Host's synchronous admission check. If the Agent is no longer running, the operation leaves the Queue message unchanged and returns a typed `steer-unavailable` error, after which the original waking message proceeds through Queue. If the driver already claimed the message, it returns the existing `queue-item-not-found` error and independent-turn delivery is already underway. The UI treats both races as converged Queue delivery without a failure notice; transport and unknown errors still surface.

The composer uses a separate best-effort contract for newly typed input. While the addressed session is idle, Enter and Cmd/Ctrl+Enter both perform an ordinary Queue send. While a primary session is running, a General Settings preference assigns plain Enter to Queue (the default) or Steer, and Cmd/Ctrl+Enter performs the other behavior; Shift+Enter inserts a newline. An addressed subagent keeps both gestures on its Queue-only continuation transport. The Host settings document persists the preference across Web origins sharing one DSH home, and it affects only the steer-capable busy-state gesture pair. If a direct composer Steer misses the current next-step window, AgentLoop automatically admits it as the next waking Queue turn and the Web does not report a failure.

### Agent and lifecycle boundary

`session.updateQueue` locates the `MessageId` in `Inbox.nextTurn` and requires the Agent to be running. It then removes that exact message and synchronously passes the same immutable `UserMessage` to `Agent.steer()`. The two Inbox mutations append a canceled `next-turn` deletion followed by a `next-step` insertion without an await or a second RPC, while preserving the message id, content, and source. Choosing steering changes delivery from an independently admitted turn to current-turn next-step input; it neither cancels current work nor reorders the remaining Queue.

### Host and client boundary

`session.updateQueue` carries the `steer` action and maps the two negative outcomes to typed RPC errors. The conversion is one synchronous pair of Inbox operations; the Host never reconstructs it by combining remove and prompt RPCs.

AgentRegistry's standard `inbox` session projection is the sole Web pending-input authority. It folds durable `agent/inbox/spliced` events without consulting a live Agent and carries the raw `next-turn` and `next-step` lists. QueueDock renders `next-turn`, while ChatView renders user-origin `next-step` messages at the conversation tail after the `Deep diving...` running-status row, with Copy but without Fork, edit, or delete actions. The generic projection carrier supplies live pushes, history-tail reconnect baselines, cold-log folding, and process-restart recovery, so this visibility requires neither client optimism nor a live-only mirror.

When AgentLoop claims pending steering, its pure deletion splice removes the message from `next-step`. The matching durable `user/message` then enters the ordinary conversation-node projection, which restores the clock and Copy against its logged event time and sequence. No client-side Inbox fold or projection-owned handoff list participates.

The existing `session.prompt(mode: 'steer')` contract remains best-effort for new primary-session input: outside the next-step window it becomes a waking follow-up. The composer carries an explicit `queue | steer` mode through slash adjudication and reference serialization before calling that contract. A browser submission policy owns the live busy-Enter preference while the Host settings service owns durability; the policy resolves plain versus accelerated Enter as complementary gestures only for steer-capable sessions, and the Settings row and InputBar share it without duplicating storage or delivery-window authority. Only the Queue row action is strict, because either negative result converges through the original Queue occurrence.

### Verification

AgentLoop contract coverage holds prompt admission open, converts one exact queued occurrence, and proves the replacement steering occurrence keeps the message value and delivery receipt, drains as a `user/message`, and never starts its former independent turn. It also pins unavailable-window retention, claimed-address rejection, and re-entrant cancellation lifecycle conservation.

Host schema and proxy tests cover the new action, both typed errors, Inbox projection snapshots, reconnect replay, and durable deletion ordering. Client tests cover silent convergence of both semantic races, genuine error reporting, read-only subagent rows, and Queue-only subagent gestures. Runtime and ChatView tests cover direct pending Inbox rendering, while Web ARIA snapshots cover pending steering after the running-status row and the later durable node.

The keyless Web steering scenario queues a message through the real composer while the first response streams, activates the row arrow, then uses `ask_user_question` as a stable pending-steering barrier. It proves the Host-backed pending bubble appears before admission, hands off to one durable interjection after the answer, and affects the next model request. Assembled composer scenarios prove default-mode Cmd+Enter reaches the same pending and durable path without creating a Queue row, while Steer-mode Cmd+Enter creates a Queue row instead. Settings and submission-policy coverage pin the default, persistence, busy-only scope, and complementary gesture mapping; Queue edit/delete scenarios continue to prove those actions are unchanged.

## Alternatives considered

**Delete the row, then call `session.prompt(mode: 'steer')` from Web.** Rejected because two RPCs cannot make deletion and steering atomic; failure and driver-claim races can lose or duplicate the user's message.

**Restore Queue promotion under the upward arrow.** Rejected because moving an item to the front still creates an independent admitted turn. The control promises current-turn steering, not priority within Queue.

**Use the existing best-effort `agent.steer()` behavior for the Queue row.** Rejected for that action because a closed next-step window would create a new queued occurrence, possibly at a different position and identity. Strict refusal preserves the original occurrence so the UI can treat it as the same accepted Queue delivery. Newly typed composer input has no existing Queue occurrence to preserve, so it intentionally uses the best-effort behavior.

**Change `agent.steer()` to be strict for every caller.** Rejected because TUI and plugin callers use its safe follow-up fallback for newly submitted input. A queued row has recoverable state that those callers do not.

**Mint a second row identity while changing placement.** Rejected because `MessageId` already addresses the durable pending message across both Inbox lists. Keeping it through the synchronous deletion and insertion lets one projection express the delivery change without an occurrence wrapper.

**Add a dedicated pending-steering projection and client store.** Rejected because queued and steering messages already share the standard durable `inbox` projection. Each client surface selects the owned list and message sources it presents without duplicating reconnect state or ordering authority.

**Cancel the active turn and run the selected Queue item.** Rejected because it destroys unrelated in-flight work and starts a new turn rather than steering the current one.

## Consequences

`inbox` is the domain-owned durable session projection. Pending steering survives reconnect and process restart and appears immediately from `next-step`; after claim, the durable conversation node follows through the ordinary event projection. The running bit can change between rendering and the synchronous operation, so an enabled action may return `steer-unavailable` while the product continues through Queue without reporting failure.

The explicit action changes delivery from an independently admitted turn to current-turn steering. Its two durable splices briefly expose the deletion and insertion as adjacent projection revisions, while client snapshot batching converges on the message moving from `next-turn` to `next-step`.
