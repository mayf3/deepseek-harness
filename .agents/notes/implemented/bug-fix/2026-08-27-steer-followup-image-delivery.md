# Agent Note: Steer and follow-up image delivery

Status: implemented

English | [中文](2026-08-27-steer-followup-image-delivery.zh.md)

## Problem

Images submitted while an agent is running did not reliably reach the model context (#3186), for three independent reasons.

First, a steer or follow-up spliced into a live driver latched no wake: the live driver was expected to claim it, but a turn that finished or failed between the splice and the claim exited without re-checking, stranding the accepted message until an unrelated waking send. Image admission widens this window because the Host awaits attachment normalization before `agent.steer()`/`agent.followup()` runs.

Second, continuable-subagent follow-ups rejected images in the Client (`SUBAGENT_IMAGE_UNSUPPORTED`) before any RPC, and stripped image parts from the text-only call. The Host route had no admission at all, and its wire content was `ContentBlock[]`, so lifting the Client rejection alone would have let a browser cite any `attachmentId` it never uploaded.

Third, the browser queue projection reduced a queued image to the text `[image]` even though the durable reference was already present and readable through the session attachment authorization.

## Decision

**Closing-turn wake delivery.** `ReactLoopAgent` tracks the identities of waking sends still awaiting a claim (`pendingWakes`); claim and discard notifications prune the set. At a driver exit whose turn loop returned without throwing, a non-empty set re-wakes the driver, so a steer or follow-up that lost the race with a normally closing turn is claimed by a fresh turn. Cancellation and `agent/pre-step` rejection instead clear the set: accepted-but-unclaimed input parks until the next waking send, preserving the tested `cancel({ keepInbox: true })` semantics and keeping rejected claims from being re-offered to the rejecting policy. Injected context never enters the set. The turn-flow section of [docs/architecture.md](../../../../docs/architecture.md) records the delivery/parking rule.

**Host-side subagent image admission.** `SubagentPromptRequest.content` is now upload-shaped `PromptContentPart[]` (updating the wire contract in [Web subagent conversations](../feature/2026-07-27-web-subagent-conversations.md)). `dsh-attachment` owns the shared upload vocabulary used by the subagent route; `dsh-api-session-controller` retains a structurally identical Client-face declaration so the generated Client Cordis catalog contains the complete prompt-part fields, with a compile-time equality test preventing drift. The shared `durablePromptContent()` conversion lives in `dsh-llm/content` and is used by both the Session prompt endpoint and `SubagentRuntime.prompt`. The subagent route admits and persists image batches through `ctx.attachments` before `followup()`, and the continuation manager refuses delivery inside the per-child lock when the child's `agent.options` route resolves to a model without image input (`MODEL_DOES_NOT_SUPPORT_IMAGES`, surfaced as `attachment-error` with the same reason vocabulary as the Session route). A child without a fixed options route, or a deployment without the LLM registry, delivers and relies on the LLM layer's text-only projection. The Client forwards image parts unchanged and the `SUBAGENT_IMAGE_UNSUPPORTED` copy is gone.

**Queue presentation.** The queue mirror's text preview excludes image blocks, and the queue dock renders each durable image part as a thumbnail resolved through `ctx.uiConversation.imageUrl` — the same session-authorized read the transcript uses. Editing queued image messages stays refused (#3072).

## Alternatives considered

**Re-wake on every driver exit with pending input.** Rejected: it breaks the deliberate parking semantics of `cancel({ keepInbox: true })` and pre-step rejection, and a pre-commit `turn/start` failure would re-enter a hot loop because the failing turn never claims the message.

**Latch `wakeRequested` for sends to a live driver.** Rejected: the latch is not pruned on claim, so a claimed steer plus leftover injected context would open a context-only turn at exit, violating the rule that injected context waits for a waking message.

**Keep the wire content `ContentBlock[]` and admit refs on the Host.** Rejected: a reference-shaped wire lets a Client fabricate `attachmentId` citations; an upload-shaped wire makes Host admission the only way an attachment reference can exist in a child message.

**Check child image capability in `SubagentRuntime.prompt`.** Rejected: the route may address a cold child whose agent does not exist yet; the continuation manager sees the live or freshly materialized agent in both arms and inside the per-child delivery lock, so the check cannot race a concurrent delivery.

## Testing

Agent-loop tests pin the closing-turn window deterministically (a `turn/end` listener queues the send as a microtask ahead of the driver's exit continuation) for steer, follow-up, and the inject non-delivery case. Host tests cover `mode: 'steer'` image admission; subagent control tests cover ordered admission, batch refusal, non-canonical base64, and the capability refusal mapping; continuation tests cover refusal without a partial message, capable delivery, and the routeless deferral. Client tests cover unstripped forwarding, the catalog-visible upload declaration, queue thumbnails (load, failure placeholder, unmount), and the image-free preview.

## Consequences

A steer or follow-up accepted during a turn's final microtasks is now delivered by a fresh turn instead of hanging in the inbox, while user cancellation still parks pending work — delivery after a stop remains an explicit next waking send. The subagent package now depends on `dsh-attachment` and reads `ctx.llm` optionally. Images persisted by a batch whose delivery is later refused stay as unreachable content-addressed objects under the existing retention rules. Queue thumbnails add one authorized attachment read per queued image, shared with the transcript cache.
