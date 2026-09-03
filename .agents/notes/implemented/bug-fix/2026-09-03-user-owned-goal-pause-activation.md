# Agent Note: User-owned goal pause exposes live activation

Status: implemented

English | [中文](2026-09-03-user-owned-goal-pause-activation.zh.md)

## Problem

The host-pause fix in [Host-initiated goal pause aborts the live turn](2026-09-01-host-goal-pause-aborts-turn.md) stopped the current model turn, but a later human turn could still use `update_goal resume` to lift a durable `paused` goal. The Web strip also read only the durable `goal` projection, so an active-but-disarmed goal and an armed goal rendered identically and offered the same pause action.

## Decision

`ctx.goals.get` is a read-only Remote method. `GoalService` emits `goal/activation-changed` whenever its process-local activation changes, with `{ sessionId, goal: { id, revision, activation } }` or no goal after a clear. The API Remote allowlist forwards that JSON payload to Web clients.

The GoalBar seeds process-local activation from `ctx.remote.goals.get`, applies `goal/activation-changed`, and refreshes on durable revision or session running-state changes. Active goals render `Ongoing Goal` only when armed; active-but-disarmed goals render `Inactive Goal`, expose resume instead of pause, and durable paused goals keep exposing resume. Pause authority remains in the goal domain and human `/goal resume` command, which can still resume every resumable phase.

The `update_goal resume` action rejects a durable paused goal with `GOAL_TOOL_RESUME_PAUSED` before calling the goal service. It still resumes an active-but-disarmed goal after session restore or fork and a blocked goal after human continuation. The model prompt and tool description state that the user owns durable paused resume.

## Alternatives considered

**Store activation in the durable `GoalSnapshot`.** Rejected: activation is process-local by the goal domain contract and must not survive restore or fork.

**Add activation to the persisted session projection.** Rejected: projection state is checkpointed; a cached `armed` value would incorrectly outlive the process that armed it.

**Forward the full scoped `goal/changed` event to clients.** Rejected: its `Agent` payload is not JSON wire data. The dedicated activation event carries only the session id, goal ref, and activation clients need.

**Let the model resume durable paused goals from natural-language turns.** Rejected: a manual pause is a user control, and prompt-only restraint leaves the same turn-level undo available to the model.

## Consequences

The Web can distinguish running, disarmed, and paused goals without persisting activation. A durable paused goal is resumable only through the Web control, `/goal resume`, or another direct goal-service caller; model `update_goal resume` is limited to disarmed-active and blocked goals. The API surface gains one read and one forwarded live event; durable goal change payloads and projection state versions are unchanged. Human cancellation now requires the user-facing resume path as well.

## Testing

Goal unit tests pin the activation event across create, session start, and resume. Tool tests pin rejection of a durable paused goal in a later human turn while restored disarmed-active goals still resume. API Remote tests pin JSON forwarding. Web unit tests pin armed pause versus disarmed resume rendering and event application; the assembled goal-bar browser scenario still pins the armed golden.
