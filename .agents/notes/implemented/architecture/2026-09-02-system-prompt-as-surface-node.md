# Agent Note: The system prompt is surface node 0

Status: implemented

English | [中文](2026-09-02-system-prompt-as-surface-node.zh.md)

## Problem

A system prompt held outside the surface has a different durable representation from every other message the model reads. Conversation messages are surface events (`user/message`, `assistant/message`, `tool/result`) folded in seq order by `Session.deriveMessages()`; a prompt stored as a `system` field of the log-only `request/header` snapshot has to be prepended by each serializer as wire message 0. The [reconstructable-requests Agent Note](2026-07-05-reconstructable-requests.md) made both halves durable, but that layout leaves one model-visible fact with two homes: the surface owns the messages, the header owns the message in front of them.

That split forces every reader of "what did the model see" to join two sources: the compaction summarizer copies the header prompt in front of the region's derived messages, `dsh-token-meter` estimates the system prompt from the header while pricing every other message from the surface, and the Web request-prompt card, the trajectory view, and the snapshot normalizer's `{{system}}` placeholder each read the header on their own. Change detection is split the same way: a `headerEquals` that compares `system` byte-for-byte beside `config` and `tools` makes a prompt change and a tool change indistinguishable in the log (`request/header` reason `change`) even though they are different operations on the conversation.

The split also blocks the next step. A model that accepts a mid-conversation `system` message as a prompt replacement needs the harness to append a system-role message to history; with the prompt living in the header there is no surface representation to append, and the header would have to be frozen by special case. The [in-history replacement proposal](../../proposed/feature/2026-09-02-in-history-system-prompt-replacement.md) depends on this note.

## Decision

The system prompt lives on the surface. It is an ordinary surface event, `system/message`, and every prompt lifecycle operation is one of the two existing `SurfaceOp` variants applied to that event type. The wire request is unchanged: the surface fold yields the message list the serializers send, with the system message first.

### The event

`system/message` is a member of `SurfaceEventType` beside `user/message`, `assistant/message`, and `tool/result` (`packages/core/session/src/types.ts`). Its payload mirrors `tool/result`: `{ turn, step, message }`, where `message` is a `SystemMessage` with `role: 'system'`, one text block holding the rendered prompt, and source `{ kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }`. Empty `content` records "no system prompt": the node keeps its surface position and `deriveEventMessage` projects it to `null`, so it contributes no wire message. A non-empty node projects verbatim, so `deriveMessages()` returns the system message at its surface position and the DeepSeek serializers, which pass a `role: 'system'` history message through unchanged, emit it as wire message 0. `EpochHeader` is `{ config, adapterDefaults?, tools? }`; `canonicalHeader` and `headerEquals` in `packages/core/session/src/request-header.ts` compare config, adapter defaults, and tools only.

### The operations

| Situation | Surface operation |
|---|---|
| No `system/message` survives on the surface and the rendered prompt is non-empty | append `system/message`; on the session's first step it is surface node 0, before the first `user/message` of the step |
| A `system/message` survives and the rendered prompt differs from its text (including a prompt that becomes empty) | replace exactly that node: `surfaceOp: { op: 'replace', start: <seq of the node>, end: <same> }`, `sourceEventSeqs: [<seq of the node>]`; an empty prompt produces an empty-content node that projects to no message |
| No `system/message` survives and the rendered prompt is empty | no system node is appended |
| The rendered prompt equals the surviving node's text | no operation |

The append row is exact about position: a prompt that first becomes non-empty after user messages exist appends its node at the surface tail, not at node 0, and the head protection below does not cover it. Replacing node 0 is a head rewrite expressed on the surface: the provider prefix changes from the first token, the log records the shadowed node through `sourceEventSeqs`, and `replaceGeneration` advances as it does for a compaction replacement. The loop's `startsSeries` detection (`requestSurfaceGeneration !== surfaceGeneration`) therefore covers the prompt change without a `system` comparison in `headerEquals`. `request/header` keeps reasons `initial`, `resume`, `change`, and `series`; `change` means config or tools changed, and the unchanged header that follows a prompt replacement logs as `series`.

`packages/core/session/src/surface.ts` enforces the head invariant in `assertSystemHeadRewrite`: a replacement whose range covers surface node 0 while node 0 is a `system/message` is rejected unless the replacing event is itself a `system/message` covering exactly that node. System nodes at later positions carry no such protection; a compaction range may shadow them.

### Ownership in the loop

`dsh-agent-loop` owns `SystemPromptProjection` beside `RuntimeContextProjection` in `packages/core/agent-loop/src/runtime-context.ts`. Its constructor restores the latest surviving `system/message` from the log and follows `session/event` for new system nodes and for replacements whose `sourceEventSeqs` shadow the retained one. `project(rendered)` returns `{ message, intent }` — `intent` is `{ surfaceOp: 'append' }` when no system node survives, otherwise a replacement of exactly the retained node — or `undefined` when nothing changes.

In `packages/core/agent-loop/src/agent.ts`, `preStep` renders the prompt with `renderPrompt(assembly)` and projects it; `turn()` commits the `system/message` immediately after `step/start` and before the step's `user/message` events, so log order is wire order. `buildRequest` sets no `system` on the request: the request is `header.config`, `session.deriveMessages()` (system message first), and `header.tools`. The loop step order is: claim inbox → `systemPrompt.assemble()` → project system prompt → project runtime context → `agent/pre-step` waterfall → `step/start` → commit `system/message` (when changed) → commit `user/message`s → `agent/request` waterfall → `request/header` → `request/context` → stream. The `dsh-agent-loop/invariant` companion (`packages/core/agent-loop/src/invariant.ts`) asserts that a loop-built request has `system === undefined` and `messages` equal to `deriveMessages()`.

### Consumers

| Consumer | Reads |
|---|---|
| DeepSeek serializers (`serializeRequest`, `serializeRequestWithImages`) | `options.messages`, passing the `role: 'system'` history message through as wire message 0; `GenerateOptions.system` remains for direct one-shot callers such as title providers |
| `dsh-llm-pi-ai` | a leading system history message maps to pi-ai's `systemPrompt` |
| `compaction-basic` `buildSummarizationInput` | node 0's derived message prepended to the region in `SummarizationInput.messages`, with no separate `system` field; an empty-content head projects to no message while staying protected from compaction |
| `compaction-basic` `selectCompactableRange` | anchors at the first non-system node; node 0 is never inside a compaction range |
| `dsh-token-meter` | the system node is priced as a surface node under the `systemTokens` breakdown |
| Web request-prompt card, trajectory request node, request inspection | the `system/message` node; a replaced node 0 is shown as a prompt change in a collapsed inspectable card, never a chat bubble |
| Snapshot normalizer `{{system}}` placeholder, plan-mode tests | the system node's text |
| TypeScript and Python SDK expected outputs | include the `system/message` event |
| Human transcript projections | skip `system/message`; it is model history, not conversation |

`RuntimeContextProjection` and `SystemPromptProjection` are symmetric: both watch owned surface nodes and their shadowing through `sourceEventSeqs`, and both hand the loop an uncommitted message that `turn()` commits. The difference is the role and the operation set — runtime context appends user-role snapshots only, the system prompt appends once and then replaces.

## Alternatives considered

**Keep `header.system` and add `system/message` only for updates.** Two homes for one fact: every consumer above would read the header for message 0 and the surface for later messages, and the loop would need a special case that ignores `system` in `headerEquals` while a surface system node exists. Rejected because the point of the change is one representation.

**A dedicated log-only `system-prompt/change` event that rewrites the header.** Preserves the header as the home of the prompt and records changes as their own event kind, but still cannot express a system message inside history, so the in-history proposal would need a second mechanism anyway. Rejected.

**Synthesize the system message inside the adapter from consecutive headers.** The adapter is stateless per request and never sees the log; a wire history that depends on adapter state is not reconstructable from the surface fold. Rejected.

**Express the prompt as a `user/message` snapshot like runtime context.** Reuses an existing event type but sends the wrong role, so a model that treats a system message as authoritative would not. Rejected.

## Consequences

- One representation: every reader of "what did the model see" folds the surface; no consumer joins the header to the message list. `EpochHeader` has no `system` field, so a reader that expects one fails at compile time.
- A prompt change and a tool or config change are distinguishable in the log: the former is a `system/message` replacement of node 0 followed by a `series` header, the latter a `request/header` with reason `change`.
- Compaction carries an invariant: node 0 is never compacted. The `dsh-session` surface manager enforces it in the replace operation itself, so a compaction provider other than `compaction-basic` cannot shadow the prompt by anchoring at `surfaceNodes[0]`. Later system nodes are unprotected by design.
- `replaceGeneration` advances for a prompt replacement as well as for compaction; a reader that needs to distinguish them inspects the replacement event's type.
- A mid-history system node has a surface representation, which is what the [in-history replacement proposal](../../proposed/feature/2026-09-02-in-history-system-prompt-replacement.md) builds on.
- A prompt that first becomes non-empty after user messages exist lands at the surface tail rather than node 0, outside the head protection; the loop-owned projection reaches this case only when the session's first step rendered an empty prompt.
- Recorded snapshot fixtures carry the `system/message` event instead of a header `system` field. The snapshot normalizer tokenizes that event's text to `{{system}}`, the prompt sidecar is harvested from the `system/message` sequence (one section per prompt version, declared as `header.promptChanges`), and `request/header` pins compare config and tools only.

## Testing

- `packages/core/session/tests/surface.spec.ts` (`system/message surface node` block) pins the leading system-role projection, the empty-content `null` projection, `assertSystemHeadRewrite`'s acceptance and rejection paths, the unprotected later system nodes, and the rejection of a seeded `system/message` with a non-system role or non-plugin source.
- `packages/core/agent-loop/tests/system-prompt-projection.spec.ts` pins the append on first render, the no-op on an unchanged prompt, the replacement of the retained node on change, restoration from the log, and the tail append after a replacement shadowed a non-head system node.
- `packages/core/agent-loop/tests/request-reconstruction.spec.ts` (`a system-prompt change replaces surface node 0 and starts a new series under the same header`) pins the `series` header that follows a prompt replacement.
- `packages/core/agent-loop/tests/invariant.spec.ts` pins the companion's rejection of a loop request carrying a `system` field and its `messages` equality check against the boundary derivation.
- `packages/llm/llm-deepseek/tests/serialize.spec.ts` (`serializes a leading system message byte-for-byte like the same prompt passed as options.system`) pins wire identity. `packages/llm/llm-pi-ai/tests/context.spec.ts` compares both system sources on text and image paths. `packages/compaction/compaction-basic/tests/compaction-basic.spec.ts` pins the derived prefix, routed tools, absent separate `system` option, and protected non-empty or empty head through the region transaction and default summarizer.
- The recorded snapshots under `snapshots/` pin the model-visible wire request of every shipped profile; a recorded session that renders a prompt carries the `system/message` event at surface node 0 in its `session.jsonl`, and a session with a mid-session prompt change carries the replacement of node 0.
