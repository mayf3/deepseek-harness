# Agent Note: In-history system prompt replacement for cache-stable prompt changes

Status: implemented

English | [中文](2026-09-02-in-history-system-prompt-replacement.zh.md)

## Problem

Every system prompt change costs the whole provider prefix cache. The loop renders the prompt on every step; when the bytes differ — a plan-mode section entering or leaving, a skill or tool guidance section registering, an agent-scoped persona shadow, a changed `{{model}}` variable — the request's message 0 changes and the DeepSeek context cache misses from the first token. Long agentic sessions pay this repeatedly, and the [runtime-context snapshot design](../../archived/feature/2026-07-30-current-sandbox-policy-context.md) exists precisely because moving a changing fact out of the prompt was the only way to keep the prefix stable.

A DeepSeek model, recorded here as a model fact supplied for this work, removes that constraint: it accepts a `system` message at any position of the conversation and treats the latest one as the complete effective system prompt, replacing the leading one. Tool schemas remain part of the cached prefix, so a tool-set change still invalidates the cache. With that model the harness can append the new prompt after the cached history instead of rewriting message 0, and the prefix stays warm.

The harness has the representation for this because the [system prompt is surface node 0](../architecture/2026-09-02-system-prompt-as-surface-node.md): a prompt change is an operation on `system/message` surface nodes, and the choice between "replace the latest system node" and "append a new node" is a per-route decision.

## Decision

For a model route that declares the capability, the loop appends a new `system/message` surface node instead of replacing the latest system node when the rendered prompt changes and the prefix would otherwise survive. Everything else in the [surface-node decision](../architecture/2026-09-02-system-prompt-as-surface-node.md) is unchanged: the event type, the projection owner, the serializers, and the node 0 head protection.

### Capability

`dsh-llm` defines `SystemPromptUpdate = 'in-history'` and carries it as an optional sibling field, `systemPromptUpdate`, on `LlmResolvedModelInfo` and `PreparedLlmCall`; `normalizeModelInfo` rejects any other value with an `LlmError` whose code is `INVALID_MODEL_INFO`. The DeepSeek adapter's catalog model (`DeepSeekCatalogModel.systemPromptUpdate`, validated by zod at load) and the replay provider's `ReplayModelConfig.systemPromptUpdate` declare it per model; absence means the model needs message 0 rewritten. No default catalog entry declares it; a deployment enables it through the `models` list in `cordis.yml`, and every `dsh-llm-pi-ai` route keeps the replace behaviour.

The loop records the mode in the session: `RequestContext.systemPromptUpdate` joins provider, model, and capacity as a `request/context` field, logged whenever any of them differs from the latest snapshot. The decision reads `session.requestContext()?.systemPromptUpdate`, so a resumed loop instance applies the mode of the route it last requested with, and a route change takes effect from the first request after it is logged.

### The decision rule

`SystemPromptProjection.project(rendered, { inHistory, startsSeries })` in `packages/core/agent-loop/src/runtime-context.ts` scans the surviving `system/message` nodes of the current surface on every call. With no surviving system node it appends when the rendered prompt is non-empty; when the latest system node already holds the rendered text it emits nothing. Otherwise:

| Route capability | Prefix state | Operation |
|---|---|---|
| none | any | replace the latest surviving system node (node 0 when no later one exists) |
| `in-history` | the current request series continues | append a new `system/message` before the step's `user/message` events; no `request/header` is logged |
| `in-history` | a new series starts and node 0 is the only surviving system node | replace node 0 with the current prompt |
| `in-history` | a new series starts and a later system node survives | append a new `system/message`; node 0 stays as it is |
| `in-history` | the rendered prompt is empty | replace the latest surviving system node with empty content, which projects to no message |

`startsSeries` is true when the `agent/pre-step` decision declares `startsRequestSeries`, when the surface replace generation moved since the last request (a compaction or any other replacement), or when the visible tool-schema set changed. A provider or model swap alone is not a series start for this rule: the changed prompt is appended, which costs nothing because the route change already misses the cache. The third row exists because a series start already costs the cache; folding the prompt back into node 0 keeps the history short. The fourth row exists because the surface has no delete operation: replacing node 0 while a later system node survives would leave the model reading the later, stale node as authoritative. In-history mode never rewrites node 0 while any later system node survives.

`preStep` in `packages/core/agent-loop/src/agent.ts` projects the prompt after the `agent/pre-step` waterfall, so a compaction that runs inside that waterfall (`compaction-basic` with `auto: true`) is visible: when it shadows every later system node, node 0 is the only survivor and the changed prompt replaces it. Resume is series-continuing — the `resume` header is not a series start — so a prompt that changed across a restart is appended; the provider cache may still be warm across a process boundary.

### Presentation and accounting

Web presents an appended in-history node at its own position. `SystemPromptNode` carries `{ seq, time, turn, step, text, update }`, `update` being true for an appended `system/message` that follows an earlier system node in the loaded window. Chat renders a non-empty update as a collapsed `system-prompt` card titled by the locale key `message.systemPromptUpdate`, and a `request/header` in the same turn and step does not repeat the prompt card; `inspectRequestPrompt` reports no system change for a header that follows an update. Trajectory folds an update following a loaded request header into a synthetic request-header fact with `promptChange.kind = 'system'`, so later requests show the effective prompt without a real header change. When the loaded window lacks the earlier system node, the update is presented as an initial prompt. Transcript projections skip it like every `system/message`.

`dsh-token-meter` prices the appended node like any surface node. Its `contextBreakdown` reports the newest system node as the system figure and moves the superseded prompt's tokens into the message figure on the append, so a compaction claim over a shadowed prompt version subtracts exactly what the append added; the `dsh-token-meter` README records the one drift case, a compaction shadowing the newest in-history node, which the loop repairs on the next step by replacing node 0. `cacheReadTokens` on the following `assistant/message` usage is the observable effect: on a capable route the value covers the prefix through the last cached message; a rewritten node 0 drops it to the shared-prefix detection floor.

### Compaction

`compaction-basic` is unchanged. `selectCompactableRange` still anchors at the first non-system node, so node 0 is never shadowed and later in-history nodes can be; `buildSummarizationInput` replays node 0's text as the summarizer `system` and every shadowed node's derived message in surface order, so a mid-region system node is replayed in place and the summarization call remains a genuine prefix of the conversation.

## Alternatives considered

**Send only the changed sections as a delta.** The model treats the latest system message as the complete prompt, so a delta would silently drop every unchanged section. Rejected on the model contract.

**Enable in-history mode by plugin config instead of a model capability.** A deployment flag could pair a non-capable model with appended system messages, which such a model would read as ordinary history at best. The capability belongs to the route that honours it; the adapter catalog already carries per-model capacities. Rejected.

**Always append, never re-baseline.** One rule, but node 0 would stay stale for the life of the session and every request after compaction would carry the stale head plus the replacement. Re-baselining at a series start costs nothing extra because the cache is already lost there. Rejected.

**Re-baseline on every resume.** Accepts one cache miss per process restart for a simpler resume path. The cache persists across restarts for hours to days, and the log already carries what resume needs. Rejected.

**Place the system message after the step's user messages.** Both positions sit after the cached prefix, but the model then reads the instructions after the input it must apply them to; system-before-user matches the leading position's ordering. Rejected.

**Project the prompt before the `agent/pre-step` waterfall.** The projection would not see a compaction performed inside the waterfall, so a just-appended node could be shadowed in the same step and the request would carry node 0's stale prompt as the only system message. Projecting after the waterfall keeps the rule a pure function of the surface the request is built from. Rejected.

**Treat a provider or model swap as a series start.** It would fold the prompt into node 0 on every route change, matching the tools case. The header already records the change and the cache misses either way, so the extra rule bought nothing but a special case in the loop. Rejected.

**Report every surviving system node in the breakdown's system figure.** Summing the nodes shows the retained prompt versions' cost directly, but a compaction claim that shadows a superseded version would then have to be split between the system and message figures. Moving the superseded prompt into the message figure on append keeps each claim a plain subtraction. Rejected.

## Consequences

- A prompt change on a capable route keeps the provider prefix cache; the appended node costs its own tokens on every request in the series until compaction shadows it. A deployment whose prompt changes on most steps is better served by moving that fact into runtime context.
- The request head is not the only place a system prompt can live: readers of "what did the model see" fold the surface and take the latest system node, and the breakdown's system figure follows the same rule.
- A `request/context` snapshot varies with the declared mode as well as the route, and the loop's decision depends on the latest one.
- The model contract is recorded as supplied. If a released model narrows it — for example honouring only the latest system message within a bounded window — the rule needs a re-baseline trigger beyond series starts.
- A proxy that rewrites or reorders system messages breaks the replacement semantics silently; the real-API e2e's cache-hit assertion is the detector.

## Testing

- `packages/core/agent-loop/tests/system-prompt-projection.spec.ts` pins the append on a continuing series, the re-baseline of a lone node 0 at a series start, the append at a series start with a surviving later node, the empty-prompt rewrite, and the replace-only behaviour without the capability.
- `packages/core/agent-loop/tests/request-reconstruction.spec.ts` pins the appended node under an inherited header with `request/context` carrying `systemPromptUpdate`, the series-start fold into node 0, the compaction-driven re-baseline, and the tool-schema change re-baseline under a `change` header that starts a series.
- `packages/llm/llm/tests/service.spec.ts`, `packages/llm/llm-deepseek/tests/adapter.spec.ts`, and `packages/test-support/llm-replay/tests/llm-replay.spec.ts` pin the declared mode on resolved model info and the load-time rejection of any other value.
- `packages/llm/token-meter/tests/context-breakdown-projection.spec.ts` pins the superseded prompt moving into the message figure and its subtraction by a compaction claim.
- `packages/client/ui-conversation`, `ui-chat`, and `ui-trajectory` client specs pin the update card, the same-step header dedupe, the absent system change after an update, and the synthetic trajectory header.
- The keyless authored snapshot `snapshots/session/system-prompt-in-history/` declares the capability on the replay route, changes the prompt after the first tool call through a fixture section, and pins the appended `system/message`, the untouched node 0, the single `request/header`, and the `request/context` mode.
- `packages/llm/llm-deepseek/tests/adapter.e2e.ts` runs a two-step prompt change against the model named by `DEEPSEEK_IN_HISTORY_MODEL`, asserts that the reply follows the appended prompt, and asserts that the appended request reads more cached tokens than the same conversation with a rewritten leading prompt; it skips when the variable is unset.
