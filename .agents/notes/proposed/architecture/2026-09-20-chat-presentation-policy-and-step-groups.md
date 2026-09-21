# Agent Note: Chat presentation policy channel and process-group architecture

Status: proposed

English | [中文](2026-09-20-chat-presentation-policy-and-step-groups.zh.md)

## Problem

At the start of this proposal, Chat's display setting had two modes: `normal` did not fold content, while `compact` folded process rows behind a whole-Turn control after completion. `TranscriptViewPolicy.mode` was injected into ChatView as an observable. ChatView read it through `useTranscriptView`, converted it to the boolean `compactTranscript`, and passed that prop through `ChatNodeList` to every `ChatNodeSeat`. The global `hasMore` boolean followed the same path as `historyIncomplete`. Either change re-rendered every seat, even when only a few foldable rows changed their output.

The product requires three modes—Compact, Detailed, and Expanded—with consecutive process rows between replies collected into collapsible groups in Compact and Detailed. PR #4565 implemented the full feature, but was reverted eight minutes after merging because of performance regressions. The recorded local before/after comparison found long-session pagination +27%, DOM nodes +23%, heap +14%, and Trajectory switching +10%, all within CI budgets. None of the six existing repository benchmarks covered the new hot path: reasoning or tool chunks entering an active group during streaming, group reprojection, and seat re-rendering.

The review identified implementation choices, not the product requirements, as the problem:

- The mode became an input to list structure. `ChatNodeList` subscribed to the entire `layout` and generated wrapper components from ranges; Expanded removed those wrappers. Switching modes remounted the list, and regrouping rebuilt wrapper keys.
- The mode entered `ChatNodeOwnerProps`. Every seat's owner object changed with the mode, re-rendering all business renderers, including unrelated user messages, tool rows, and compaction markers.
- A seat split one Assistant node into derived reasoning and response objects solely to wrap the former in the DOM. Master's `AssistantMarkdown` already had `reasoningHidden` and `revealProcess`, which could hide reasoning independently.
- Consumers repeated infrastructure-row filtering in four places, although nodes already had a Definition-owned `visibility` field.

The deeper difficulty is information ownership: a group header must exist before its members as soon as the group opens, but its content requires a view of the entire Turn. Each event-driven Context receives only its own events. Only a turn-level Context can observe the whole Turn, and it can produce only one node.

This proposal supplies an architecture for three modes and grouping that satisfies the constraints below and confines later product changes to a small set of nodes.

The three settings, presentation policy channel, and per-Turn folding eligibility are implemented; step-group remains proposed. The [migration progress table](../feature/2026-09-20-chat-work-details-migration.md) owns current implementation, committed scope, and incomplete items. The grouping state machine and change inventory below do not describe delivered work.

## Goals and constraints

The [implemented Definition-owned Build Group foundation](../../implemented/architecture/2026-09-21-conversation-build-groups.md) supersedes this note's event fold, Builder-materialized group headers, Step-range membership, and changedLocationData proposal. This note retains the presentation-policy and per-Turn eligibility rationale; the grouping implementation below records the superseded route, not the current implementation plan.

The following decisions were confirmed during design review and are inputs to this proposal.

| Number | Decision | Meaning |
|---|---|---|
| 1 | Definitions own group structure | A Definition matching multiple events in the Turn folds group opening, closing, member ranges, and summaries; renderers do not derive them by scanning nodes |
| 2 | Limit seat re-rendering | Mode changes re-render only seats whose presentation changes; streaming chunks re-render only their seat and group header; user messages, replies, and turn-tail do not re-render for either change |
| 3 | One node per Context | Do not introduce multiple nodes per Context; most Contexts have one element, and arrays would fragment memory further |
| 4 | Modes do not toggle Definitions | Registry changes rebuild and replay all Contexts, refreshing every seat; Definitions must be mode-independent |
| 5 | Decide folding per Turn | A Turn can fold when its own `turn/start` is loaded; the oldest partial Turn stays open and is not optimized here |
| 6 | ui-conversation may change | Engine changes are allowed only where needed for this design to work correctly |
| 7 | Initial implementation scope | Initially change only code and this note; add tests and other documentation during CI repair |

Accepting a full-page browser layout on mode changes does not mean accepting every seat re-rendering. Layout is a geometric result; a seat re-render executes a React component function. This proposal constrains the latter.

## Viable approaches

There are five approaches to group-header identity and content ownership.

**Approach A: the first member's seat renders the header.** Keep the list unchanged. The builder derives membership and tells the first member's seat to render a title above itself; other member seats use the existing `hidden` mechanism. This adds no new concept, but creates a third seat state—visible with only a title—and attaches the header to a business node's seat.

**Approach α: one Context per step supplies a header.** Add a Definition identified by `turn:step`. During construction, read the preceding `assistant-step` data to decide whether this is a new group start and emit a header node if so. Another turn-level Definition publishes the group's content as Turn data for the renderer.

**Approach β: one Context emits multiple nodes.** A turn-level Definition emits the whole-Turn control and N group headers.

**Approach γ: a parent Context derives child Contexts.** When a group opens, the turn-level fold creates a `step-group` child Context and forwards later events to it. Each child owns one node. The engine needs forwarding and cascaded replay primitives.

**Approach δ: Definitions own structure; the builder materializes rows.** A turn-level Definition folds the group list and publishes Turn data. The Chat builder materializes header nodes and assigns membership. Seats use combined selectors for visibility. `ViewBuilder.apply` receives the Location data whose references changed in the flush.

## Alternatives considered

**One Context per group cannot satisfy the matching rules.** The engine requires `match(event)` to derive an id from one event. A group number depends on whether a reply preceded the event; one event cannot determine it. This is incompatible with the matching contract, not merely difficult to implement.

**Approach α conflicts with decision 2.** Header identity is derivable, but every header reads the same Turn data, so one group's change refreshes all headers in that Turn. Reading later steps through `turn.steps` instead leaves stale references because a header node is not rebuilt when later steps arrive.

**Decision 3 rules out approach β.** See the table above.

**Approach γ is not justified yet.** It has the clearest ownership, but forwarding and cascaded replay would add hundreds of lines to the assembler core. It remains an alternative under the conditions at the end of this note.

**Approach A remains the fallback.** If builder-owned materialization is rejected in practice, use A. Both share the same structural source and differ only in what carries the header row.

Choose approach δ.

## Proposal

### Data flow

```
事件流
  ──▶ step-groups Definition（turn 级 fold，多重匹配本轮事件）
        ──▶ Turn 数据 step-groups：组列表，每组一个对象
              ──▶ Chat builder
                    ├─ 物化组头节点：一组一个 key，data 即组对象
                    └─ 成员归属：按 step 映射到 key，写进 per-key presentation
                          ──▶ seat：hidden = f(策略字段, 角色, 展开状态)
                          ──▶ 组头渲染器：读自己节点的 data
展示策略
  ──▶ 渲染器：按 kind 注入的 hooks，选单个字段
  ──▶ seat：组合 selector，选出的是自己的结论
```

The only engine change passes the Location data whose references changed during a flush to the builder through `apply`.

### Responsibilities

| Layer | Owns | Explicitly does not own |
|---|---|---|
| `step-groups` Definition | Opening and closing groups, `headStep`, `closeStep`, tool counts and names, running tools; publishes Turn data | View nodes or identification of member nodes |
| Chat builder | Header-node identity and lifecycle, membership, `turnStarted`, identity comparison and publication of per-key presentation | Reading events or deriving business structure |
| Presentation policy object | Mapping the enum to capability fields | Node or seat state |
| Seat | Combining policy fields, role, and store state into hidden state; supplying group open/close actions to the header renderer | Determining group boundaries |
| Header renderer | Title, chevron, click-to-toggle interaction | The source of group content |
| assistant-step renderer | Settled reasoning first-line preview; hiding reasoning when closing a group | Group boundaries |

### Header-node identity and lifecycle

A header node's key is `step-group:${turn}:${headStep}`. `headStep` is fixed when a group opens, and later events cannot change its first member. The header exists and is reused from that point onward; its key does not change during streaming. Closing the group only changes `closed` in its data from false to true.

The header anchor is the first member's anchor minus a synthetic offset, placing it immediately before that member. A streaming Assistant is anchored at its first visible chunk, then at its message event after persistence. Its anchor moves once; the header follows in the same structural update without adding another update.

A header is part of the whole-Turn process and hides with its members when the Turn folds. It is not in `TURN_PROCESS_INDEPENDENT_KINDS`.

Header data is the group object published by the fold. Closed group objects never change references, so their header sources never notify. Each event that changes a running group replaces only that group's object and re-renders only its header.

### Fold state machine

The `step-groups` Definition uses the Turn number as its id, starts on `turn/start`, and matches the same event set as `turn-process`. Its State is `{ turn, groups, open }`: `groups` is an array of group objects, and `open` is the active group's index or empty.

| Event | Transition |
|---|---|
| `tool/call` | If no group is open, open one at the event's step; increment the count, record distinct tool names, and add callId to the running set |
| Appended `tool/result` | Remove callId from the running set |
| `assistant/live-chunk` reasoning delta with visible characters | Open a group at the chunk's step if none is open |
| `assistant/live-chunk` text delta or text-block end with visible characters | Close an open group at the chunk's step |
| Appended `assistant/message` | Apply the reasoning rule for visible reasoning and the text rule for a visible reply, in reasoning-then-text order |
| `turn/end` | Mark an open group as closed by the Turn end |
| `step/start`, `step/end`, `llm/retry` | No state change; retry rows belong to no group |

Three invariants apply:

- Idempotence: opening an already-open group and closing an already-closed group do nothing. Live chunks and persisted messages describing the same content do not open or close twice; replay with only persisted messages derives the same group list.
- Stable references: `update` returns the original object when State is unchanged; the `groups` array changes reference only when the group list changes; closed group objects are never replaced.
- Forward-only folding: do not read neighboring Contexts, nodes, or later history.

Turn-data publication: `buildLocationData` returns a value only for the turn phase and reuses its previous value when the `groups` reference is unchanged, preventing republication. A history window without `turn/start` uses the same fallback as `turn-process`: fold State from the available matches.

Publication timing: batch live chunks at animation frames; publish other changes immediately.

### Membership rules

The builder assigns membership by step, not by seq ranges, because live-chunk seqs and persisted-event seqs use different scales.

| Node | Rule |
|---|---|
| `tool-call` at step s | Belongs to the last group with `headStep ≤ s`. If text closes the preceding group in the same step, later tool calls open a new group at that step, so the last group is the applicable one |
| `assistant-step` at step s where a group has `closeStep === s` | Closer role: the node remains visible; folding the group hides only its reasoning through the existing `reasoningHidden` mechanism |
| Other `assistant-step` at step s | Member role: belongs to the group with `headStep ≤ s` whose `closeStep` has not been passed |
| `model-retry`, `turn-error`, `turn-max-tokens`, `turn-tail`, `user`, `steering` | Belong to no group |

Recompute membership only when the group list changes, with cost proportional to that Turn's node count. Streaming chunks that leave the group list unchanged do not publish member presentation.

The header anchors before the earliest member. If a group contains only its closer's reasoning and no members, such as reasoning followed by a reply in one step, anchor the header before the closer so the hidden reasoning still has a control that reveals it.

### Delivering group changes to the builder

The fold publishes Turn data, not view nodes. When Location data changes, the engine's `flush` sets `timelineDirty` and calls `apply` on all active targets, but the builder cannot identify the changed Turn and key. Inferring them from an unrelated node update in the same Turn and flush is not a reliable guarantee.

Add optional `changedLocationData` to `ConversationViewBuilder.apply`: the Location values whose references changed in this flush, each carrying `kind`, `turn`, optional `step`, and `key`. The assembler already compares references in `applyDirtyLocationData`; it collects those results for the builder. Chat reprojects only Turns with `key === 'step-groups'`. When the optional input is absent, the builder falls back to Turns affected by the current upserts.

### Combining hidden state in a seat

Seats stop receiving `compactTranscript` and `historyIncomplete`. A seat reads policy through `usePresentation`, selecting its own result rather than the mode:

```ts
declare function usePresentation<T>(select: (policy: {
  stepGrouping: 'collapsed' | 'none'
  foldCompletedTurns: boolean
}) => T): T
declare const group: { readonly headStep: number } | undefined

const grouping = usePresentation(p => group === undefined ? 'none' : p.stepGrouping)
const foldCompleted = usePresentation(p => p.foldCompletedTurns)
```

For a seat outside every group, `grouping` is `'none'` in all modes, so it does not re-render. `foldCompletedTurns` likewise stays true in all modes. The selector hook uses `useSyncExternalStoreWithSelector` and re-renders only when the selected value changes.

Three sources combine into `hidden`:

| Source | Condition | Reveal action |
|---|---|---|
| Whole-Turn folding | Existing rule: `turnClosed && turnStarted && has reply`, without manual expansion | Open the Turn |
| Group folding | `grouping === 'collapsed'`, member role, group not manually expanded | Open the group |
| Group header in Expanded | Header role and `grouping === 'none'` | None |

The closer's reasoning is hidden independently: the seat passes `stepGroup.reasoningHidden` through owner props to the assistant-step renderer.

The chat store keeps group expansion under a key combining `turn` and `headStep`, alongside whole-Turn manual expansion.

### Re-render scope

The following guarantees also define the next round of render-count assertions. Each row names an exact set, not an upper bound.

| External change | May re-render |
|---|---|
| A running group receives a reasoning chunk | That assistant seat |
| A running group receives `tool/call` | That tool seat and the group's header |
| A reply appears and closes a group | That assistant seat and group header; membership recomputation occurs only when opening or closing groups |
| A new group opens | Insert the new header into `order` with one structural layout; no other seat refreshes |
| Switch Compact ↔ Detailed | Only assistant-step renderers with settled reasoning |
| Switch to or from Expanded | Only member and header seats |
| Change `performanceUsage` | Only turn-tail |
| Load an earlier page | New seats and historical seats whose presentation changes |
| Change locale | All seats, as a control case |

### Presentation policy object

Separate the persisted enum from runtime capabilities. `TranscriptViewMode` contains `compact`, `detailed`, and `expanded`; reading the legacy saved value `normal` maps it to `detailed` without writing it back. Runtime capabilities are the derived `ChatPresentationPolicy`:

| Field | compact | detailed | expanded |
|---|---|---|---|
| `foldCompletedTurns` | true | true | true |
| `stepGrouping` | collapsed | collapsed | none |
| `settledReasoningPreview` | false | true | true |

The mapping has one owner. Each mode maps to a constant object with a stable reference, so the derived observable needs no subscription bookkeeping: `getSnapshot` performs a lookup and `subscribe` forwards to the mode observable.

Renderers select needed fields instead of comparing enum values. Policy is injected by kind: the assistant-step registration receives it through `inject.hooks.presentation`, just as turn-tail receives `performanceUsage`. Adding a fourth mode changes the table, not the renderers.

### Per-Turn folding

Add `turnStarted` to per-key presentation, derived from whether the Turn's `turn/start` is in the loaded window. Folding eligibility uses it instead of global `!historyIncomplete`. Completing pagination changes no global seat prop; only new nodes and presentation in their Turns change.

### Complexity requirements

| Scenario | Fold | Builder | Publication |
|---|---|---|---|
| Content chunk without a group-boundary change | O(1) transition, original object returned | No reprojection | None |
| Event that changes a group boundary | O(1) | Reproject only the owning Turn, proportional to its node count | Keys whose facts changed in that Turn |
| Structural changes and pagination | Proportional to matched events | One full pass | Keys whose facts changed |
| Mode change | None | None | None; seat and renderer selectors determine re-renders |

## Change inventory

| Package | File | Change |
|---|---|---|
| ui-conversation | `contract/conversation.ts` | Add `ConversationLocationDataUpdate` and optional `changedLocationData` to `ConversationViewBuilder.apply` |
| ui-conversation | `conversation/assembler.ts` | Collect changed Location references in `applyDirtyLocationData` and pass them through `apply` |
| ui-conversation | `index.ts` | Export the new type |
| ui-chat | `chat-settings.ts` | Three-mode enum; schema accepts legacy `normal` |
| ui-chat | `transcript-view.ts` | Map `normal` to `detailed` on read |
| ui-chat | New `presentation-policy.ts` | Policy objects, mapping table, derived observable |
| ui-chat | `settings/TranscriptViewRow.tsx` | Three options |
| ui-chat | `locale.ts` | Mode labels and group-header copy |
| ui-chat | `contract/slots.ts` | `ChatViewInjected.hooks.presentation`, `PresentationInjected`, `ChatNodeOwnerProps.stepGroup`, `StepGroupOwnerProps` |
| ui-chat | `contract/snapshot.ts` | `ChatTurnProcessPresentation.turnStarted`, `ChatNodeGroupPresentation`; combine `processSource` values per key |
| ui-chat | `contract/chat-nodes.ts` | `StepGroupChatData` |
| ui-chat | `contract/store.ts`, `stores.ts` | Manual group-expansion state and actions |
| ui-chat | `conversation-nodes/common.ts` | Header anchor offset |
| ui-chat | New `conversation-nodes/step-groups.ts` | Fold Definition and Turn-data declaration merging |
| ui-chat | New `conversation-nodes/step-group-nodes.ts` | Materialize headers and project membership |
| ui-chat | `conversation-nodes/turn-process-presentation.ts` | `turnStarted` and combined per-key presentation |
| ui-chat | `conversation-nodes/chat-snapshot-builder.ts` | Integrate materialization, consume `changedLocationData`, support key deletion in the store |
| ui-chat | `conversation-nodes/register.ts` | Register the fold Definition |
| ui-chat | `chat/ChatView.tsx` | Stop passing `compactTranscript` and `historyIncomplete`; pass `usePresentation` |
| ui-chat | `chat/ChatNodeSeat.tsx` | Combined selector, three hiding sources, `stepGroup` owner props |
| ui-chat | `chat/AssistantNodeView.tsx`, `chat/AssistantMarkdown.tsx`, `chat/ReasoningRow.tsx` | Inject policy, toggle settled reasoning previews, hide closer reasoning |
| ui-chat | New `chat/StepGroupNodeView.tsx` | Header renderer |
| ui-chat | `chat/register-node-renderers.ts` | Register header renderer and inject policy into assistant-step |
| ui-chat | `apply.ts`, `index.ts` | Create and inject policy observable; export types |

This inventory retains the complete grouping proposal. Independent features have updated READMEs, i18n pairing files, and the slot catalog. The migration record tracks tests and snapshots; those updates do not complete the outstanding grouping work.

## Acceptance criteria

Grouping validation remains unimplemented; the migration record tracks independent presentation-feature evidence.

**Render-count isolation.** Add counters to the existing `chat-view.client.spec` mounting approach: React Profiler `onRender` counts per seat, and test renderers registered in `conversation.chat.node` count by kind. Assert the exact sets in the re-render-scope table for each stimulus.

**Publication counts.** Count notifications from each key's source under the same stimuli and assert the exact set.

**Fold state-machine tests.** Feed event sequences and assert opening, closing, a new group after text then tools in one step, Turn-end closure, idempotence, unchanged closed-group references, and equivalent replay using only persisted messages.

**Membership tests.** Given the group list and Turn nodes, assert each key's role.

**Benchmark coverage.** Add incremental apply with reasoning and tools to `conversation-fold`, and a streaming fixture with tools and reasoning to `long-session-browser`. These provide wall-clock evidence, not a gate.

## Risks

- **Builder-owned node creation.** This is the first proposed node creation by a view builder. A builder may only materialize rows from Turn or Step data; it must not read events or derive business structure. Synthetic keys use `step-group:`, while Context keys begin with digits, preventing collisions. Fall back to approach A if this ownership is rejected in practice.
- **Header anchor moves once with its first member.** Persisting a streaming Assistant moves its anchor from the first visible chunk to the message event. The header follows in the Assistant's structural update.
- **Actual mode differences in this phase.** Compact and Detailed currently differ only in settled reasoning first-line previews. Running detail titles and category summaries are outside this phase; the policy table leaves room for them.
- **Pagination and partial Turns.** The oldest partial Turn neither folds nor groups. Membership uses steps and is independent of pagination.
- **Header copy.** This phase proposes only processing/completed labels and tool-call counts; category summaries remain product work.
- **Streaming chunk step.** `assistant/live-chunk` carries `step`, as used by `turn-process`; a chunk without a step does not open a group.

## Retained alternative: parent-derived child Contexts

If builder materialization exposes more ownership problems than expected, add an engine primitive: a Context's `update` may derive a child Context with an explicit kind and id, then forward later matches. Each child owns its node, publication timing, and Location. Parent replay aligns children by id; children no longer derived become hidden under the existing withdrawal rules.

This returns row identity and content to Definitions with one Context per group and no array fragmentation. It requires assembler forwarding and cascaded replay, and introduces a Context creation path outside `match`. Reconsider it if more than two business features exceed the builder's materialization limits, or if membership requires cases that steps cannot express.
