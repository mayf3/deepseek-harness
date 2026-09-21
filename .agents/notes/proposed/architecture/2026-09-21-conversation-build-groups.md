# Agent Note: Definition-owned grouping with generic Node/Group assembly

Status: proposed

English | [中文](2026-09-21-conversation-build-groups.zh.md)

## Problem

Chat needs expandable groups for continuous process content while keeping replies, user input, and Turn controls independent. Compact, Detailed, and Expanded must share grouping results; changing modes must not rebuild React instances by removing group containers, moving member parents, or changing keys.

A Chat Builder aggregates one target's Nodes and indexes. Hardcoding a Chat process projector there makes the Builder own business segmentation, even if some caching moves into generic infrastructure. Business Definitions are the registration point for these rules.

Process groups are orthogonal to Steps: one Assistant Node can contribute reasoning inside a group and a reply outside it; tools after that reply enter a later group. Step-number ranges cannot describe membership. Existing event Definitions interpret one event at a time, whereas grouping needs the Nodes those Definitions have already interpreted.

## Proposal

The foundation implements a separate, Node-input `ConversationGroupDefinition`, its registry and Session-local context, generic Builder input/publication, keyed Group storage, and the two React branches. Production Chat segmentation and PR #4565 presentation remain a separate business phase; this note stays proposed until that phase is complete. The [subsystem reference](../../../../docs/subsystems/conversation.md#group-definitions) and [source types](../../../../packages/client/ui-conversation/src/client/contract/groups.ts) own the current API details.

### Agreed responsibilities

| Requirement | Consequence |
|---|---|
| Business grouping belongs to a registered Definition | Membership, segmentation, replies, steering, retries, summaries, and cache invalidation stay together. |
| Builder and assembler do generic work | Supply inputs, dispatch Definitions, validate references, reuse identities, and publish; never construct a concrete grouping class. |
| PR #4565 defines product behavior | Preserve its behavior without copying its invasive implementation. |
| React has two root kinds | The ordered root contains NodeReference and GroupReference, not another layout object model. |
| All modes share grouping | Mode is absent from Definition input, keys, and parent selection. |
| No buildLayout | ConversationViewDefinition keeps its existing responsibilities. |
| Foundation precedes business | No production Chat grouping, summaries, notifications, or footer changes in the foundation PR. |

### Related decisions

| Record | Relationship |
|---|---|
| [Business Node assembly](../../implemented/architecture/2026-08-09-client-conversation-node-assembly.md) | Retains event matching, Contexts, Locations, one business Node per Context, and target Builders; grouping adds another input category. |
| [Presentation policy and grouping](2026-09-20-chat-presentation-policy-and-step-groups.md) | Retains Definition ownership, local subscriptions, and mode independence; replaces event folding and Step-range membership as the grouping mechanism. |
| [Work-details migration](../feature/2026-09-20-chat-work-details-migration.md) | Retains product scope and migration tracking; infrastructure alone does not complete those features. |

These records retain independent rationale and remain active. Cross-View navigation and `toolCallFocus` are outside this change; no View handles, Label Slots, or resource-navigation architecture is introduced.

## Definition input, state, and registration

`ConversationNodeDefinition` keeps `match/start/update/publication/buildLocationData/buildViewNode`. `ConversationViewDefinition` keeps `target/create/isActive/toolCallFocus`. Group business is registered through `ctx.uiConversation.groups.register(processGroupDefinition)`, not a callback on either existing Definition.

- One Group Definition per target owns the complete grouping semantics. Duplicate target registration fails rather than selecting a winner or stacking strategies.
- Registration requires an existing View target, but never constructs a Builder. First activation checks the constructed Builder for `groupInput()`; missing input fails. Ungrouped targets do not require it or allocate Group state.
- Each Session owns one derived context per registered Definition. `create()` initializes its State; it is not a `turn/start` event or an event Definition's unique start Match. Definition objects do not hold mutable cross-Session state.
- `update(context, input)` returns the adopted State. `buildGroups(context)` materializes pending output without interpreting events again or advancing counts on repeated reads. Replacement input requires a complete root and group replacement so removed Nodes cannot leave dangling references; `null` on apply retains output.
- `replace` supplies target order, synchronous `readNode`, and timeline; `apply` also supplies projected previous/current Nodes and `changedTurns`. The reader is valid during the synchronous call only and must not be retained in State.
- Node data stays in the target Node Store. Content-only updates preserve the order array. Previous values are captured before the Builder installs projected updates, including additional Nodes changed by target projections.
- `ConversationLocationIndex` accumulates changed Turns from boundaries and Location data writes. Assembler passes one drained batch to every updated target, including a Turn ending without Node upserts. Direct ungrouped Builder callers may omit this field.
- The generic GroupDataMap associates target and Data across registration, storage, and reading. Undeclared targets have no group payload type; business consumers do not reconstruct summary types with unknown assertions.

## Node/Group references and updates

`NodeKey` names an existing Context Node; `GroupKey` identifies a group within a Session, target, and Definition. `NodeReference` and `GroupReference` have equal standing in `RenderEntry`. `GroupSnapshot<Data>` stores a group's immutable data and ordered NodeReference members separately from root order. Group creation adds neither Session events nor an execution lifecycle.

`groupPart` is a renderer-owned part such as reasoning or response; omission selects the whole Node. A part may also appear at the root. Part completeness and content ownership belong to the business renderer, not the framework. Group data describes status, counts, or summaries, without copying Node bodies, tool results, or mutable business State. A group has no renderer field, CSS, coordinates, React elements, navigation, or nested groups.

| Update | Meaning |
|---|---|
| Omit `entries` | Keep root order. |
| Supply `entries`, including `[]` | Replace the complete root sequence; an empty array clears it. |
| `groups: { kind: 'replace', snapshots }` | Replace complete group records, removing omitted groups. |
| `groups: { kind: 'apply', upserts, removes }` | Upsert complete snapshots and remove named GroupKeys only. |
| Data-only change | Upsert the group with new data, reuse members, omit entries. |
| Member-only change | Upsert that group with its complete new member array; no all-group replacement. |
| Root-only change | Supply entries with empty apply upserts/removes. |
| Dissolve a group | Replace root entries with its members and remove the GroupKey atomically. Source Nodes remain. |

`entries` and `groups` are one installation batch, not independent publication channels. Removing a member reference does not delete a Node. Upserts need snapshot contents; removals need only identity. React may remount a member after a real membership change, but mode switches must not dissolve groups.

The store validates the submitted final result before mutation: every root Group has exactly one record and root position; Node references exist; duplicate upserts/removals and simultaneous upsert/removal fail. Across all roots and members, each `(NodeKey, groupPart)` appears at most once. A whole Node cannot coexist with any of its parts, but different parts may occupy different positions. Atomic moves between positions are allowed.

GroupStore indexes records and sources by GroupKey, not repeated array searches. Equivalent root/member arrays and unchanged group snapshots retain identity. Data-only upserts inspect only submitted snapshots, without scanning roots, unchanged members, or Nodes. Full replacement revalidates references and still aligns results by key. Definition caches own business calculation; GroupStore owns installed results and notifications.

## Assembly order and lifecycle

1. BoundConversation receives append, prepend, replace, or Assistant settlement from the existing feed.
2. The assembler runs existing Node Definition matching, state updates, and required Context replay.
3. Existing immediate/animation-frame/none cadence schedules publication; grouping adds no timer or event subscription.
4. Flush materializes Step then Turn Location data and target Nodes.
5. Builder.replace/apply installs projected Nodes, target order, and indexes, and retains GroupInput without notifying independent sources.
6. The assembler obtains the target's registered Group Definition context, calls update with builder.groupInput(), and adopts the returned State.
7. It calls buildGroups, validates and installs the result, and installs the target snapshot.
8. After every affected target is installed, it calls Builder.publish, publishes Group sources, and publishes Location data.
9. BoundConversation publishes the existing root Conversation source.

First activation's replaceView uses the same target update function as ordinary flush. Inactive targets create neither Builder nor Group context. Registration rebuild takes the View and Group Definitions together, discards replaced/removed Group contexts, and clears old observed output. Surviving Definitions reuse keyed stores. React receives the Node Store identity so replacement rebinds keyed hooks without replacing keys or DOM instances.

Removing a registered View Definition pauses its grouping and clears derived output, while retaining the Group Definition registration. Restoring the View uses the existing replacement flow to rebuild from the current loaded timeline. Initial Group registration still rejects a missing View target; switching tabs does not unregister a View.

Grouping never replays raw events. Node Definitions handle replay first; grouping consumes the resulting target replacement or changes. Prepend may repair boundaries and legitimately move members. Definition handles old/new Locations and changed Turns instead of treating pagination or every content chunk as a complete-history regroup.

## Concrete implementation locations

| Layer/file | Responsibility |
|---|---|
| [groups.ts](../../../../packages/client/ui-conversation/src/client/contract/groups.ts) | Group Definition, input, references, updates, typed data map, and readers. |
| [conversation.ts](../../../../packages/client/ui-conversation/src/client/contract/conversation.ts) | Optional Builder groupInput/publish and snapshot-store grouped reader; existing Node/View Definitions stay unchanged. |
| [group-registry.ts](../../../../packages/client/ui-conversation/src/client/conversation/group-registry.ts) | Existing registry base, target uniqueness, typed registration, effect/disposer lifecycle. |
| [assembly.ts](../../../../packages/client/ui-conversation/src/client/conversation/assembly.ts) | UiConversation.groups and existing binding rebuild notifications. |
| [assembler.ts](../../../../packages/client/ui-conversation/src/client/conversation/assembler.ts) | Common first-activation/flush dispatch, context ownership, installation, and publication. |
| [location-index.ts](../../../../packages/client/ui-conversation/src/client/conversation/location-index.ts) | Accumulate changed Turns, including lifecycle-only and Location-data changes. |
| [group-store.ts](../../../../packages/client/ui-conversation/src/client/conversation/group-store.ts) | Atomic reference validation, keyed sources, array reuse, and local publication. |
| [chat-snapshot-builder.ts](../../../../packages/client/ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts) | Record projected Node deltas and stable order; defer source notification. No process grouping class. |
| [ChatView.tsx](../../../../packages/client/ui-chat/src/client/chat/ChatView.tsx) | Read optional root entries and switch between node/group; fallback to existing Node order. |
| [ChatGroupSeat.tsx](../../../../packages/client/ui-chat/src/client/chat/ChatGroupSeat.tsx) | Stable group parent, member-only subscription, nested Node seats. |
| [ChatNodeSeat.tsx](../../../../packages/client/ui-chat/src/client/chat/ChatNodeSeat.tsx) | Existing Node sources/renderers, groupPart forwarding, distinct part anchors, Store-replacement rebind. |
| [slots.ts](../../../../packages/client/ui-chat/src/client/contract/slots.ts) and [apply.ts](../../../../packages/client/ui-chat/src/client/apply.ts) | Existing keyed-hook injection for Group sources; no Slot-engine change. |
| Business phase: process-groups.ts and register.ts | Definition-owned segmentation, membership, caches, summaries, and registration. |
| Business phase: AssistantNodeView, Group seat, stores, navigation | Interpret parts; group header/body presentation; local open state; Turn/group reveal, selection/copy and interruption ownership. |

## Business phase: segmentation and incremental work

Business State accepts each input, clears pending changes, and returns repeatable output. Replace builds the loaded window; apply separates structural changes from content updates and maintains affected segments or Turn-local indexes. It owns group opening/closing, stable keys, summaries, and invalidation; generic infrastructure never corrects those decisions by Node kind or Step number.

| Ordered visible input | Business action |
|---|---|
| Owning Turn changes | Close the pending group. |
| No Turn ownership | Close the group and emit an independent Node; never merge across it. |
| turn-process control | Emit independently without closing the pending process. |
| User, steering, trigger, retry, error, max-tokens, or tail | Close the group and emit independently. |
| Assistant reasoning | Append the reasoning part to the pending group. |
| Assistant visible reply | Close the group and emit the response part independently. Later tools enter a later group. |
| Other process Nodes | Append the Node to the pending group; an ordinary Step boundary does not close it. |
| Turn end | Close that Turn's pending groups even without Node upserts. |

Content growth with unchanged classification does not resegment history; it may update only the current summary. A first reply, new tool, steering, or retry can change structure. Visibility/location repair handles both old and new ownership. Real structural changes may linearly merge root references; the interface does not promise all operations are constant-time.

## React reading and presentation

The root selects `views.grouped('chat')?.entries` through the existing useConversation source. Keyed Group hooks use existing injection; each Group seat selects members, while its future header independently selects data. Members use existing keyed Node sources. Removed Group sources can read undefined before the root removes their components, so selectors tolerate absence and keep Hook order stable.

React keys derive from reference kind, NodeKey/groupPart or GroupKey, using unambiguous tuples. No separate RenderKey type or renderer dispatch field is needed. Compact, Detailed, and Expanded keep the same group container and member parents; modes change header visibility, body visibility, and styles only.

The stable Group parent is a `div` with `display: contents`, without its own layout box. CSS inheritance remains available; business styles adapt child/sibling selectors and own measurable body containers. Neither CSS variables nor geometry enter the Definition. Reading-position capture measures member Nodes and retains part-specific anchors; existing Turn navigation resolves the original NodeKey to its first visible part.

| Mode | Group header | Body |
|---|---|---|
| Compact | Short activity summary | Group open/closed state controls visibility. |
| Detailed | Summary plus live command/path/query details | Same group open/closed state. |
| Expanded | Hidden | Visible without group-level collapse or height cap; wrapper remains. |

This assumes the outer Turn process is open. Expanded retains whole-Turn folding and individual tool/reasoning disclosure; it must not eagerly mount all full Markdown. Turn-close resets of internal state are explicit business actions, not key changes. Group headers, scrolling/fades, and Turn interaction belong to the business phase.

## Alternatives considered

**Builder-owned buildGroups or process projector.** Rejected: the target aggregator would still own business rules. Moving caches into infrastructure does not change that ownership.

**Add buildGroups to the existing event Definition without new input.** Rejected: the callback name does not provide cross-Node input, lifecycle changes, or reconstruction semantics.

**Replay raw events in the Group Definition.** Rejected: it duplicates Assistant/Tool/Message interpretation and can diverge from the Builder's final visible order.

**ConversationViewDefinition.buildLayout.** Rejected: it broadens a target factory into a business layout callback rather than registering a distinct business Definition.

**One event Context per Group.** Rejected: boundaries depend on preceding visible content, not a standalone event carrying the group's start identity. A target-local derived context also admits independent Nodes outside Turns.

**Dependency graphs, ViewItem classes, factories, nested groups, or strategy stacking.** Rejected for this phase: one target input and one non-nested grouping output cover the stated need.

**Separate data-only mutation operation.** Rejected: an immutable snapshot upsert with reused members already updates summaries without replacing other groups.

**Let Group Definition add/remove both Node and Group entities.** Rejected: Node data already has an owner. Symmetrical references do not require a second Node owner.

**Remove the group wrapper in Expanded.** Rejected: changing the parent remounts members even when their keys survive.

## Acceptance criteria

1. Builder, assembler, and GroupStore contain no Chat segmentation/category rules or concrete grouping class construction.
2. Group State owns membership, segmentation, summaries, and business invalidation.
3. Ungrouped targets retain their path; duplicate registration and missing input fail without eager Builder construction.
4. Group input carries final projected Nodes, previous/current values, stable order, and lifecycle-only Turn changes.
5. Data-only upserts preserve entries and members, avoid unrelated scans, and notify only changed group sources.
6. All related Nodes, Groups, and Location data are installed before publication; invalid or overlapping references fail before Group installation.
7. First activation, append, settlement, replacement, prepend, and registry reconstruction use the common grouping path.
8. Registration replacement/removal leaves no old Group context or observed output; replacement Node stores rebind mounted members.
9. React renders only node/group root kinds and retains keys and parents across modes; local state survives mode changes.
10. Data types remain correlated through Definition, store, keyed reading, and business rendering.
11. Empty versus omitted entries, Group removal versus Node retention, and undefined removed-group sources retain their documented distinctions.
12. The separate business phase covers replies, steering, retries, no-Turn rows, Turn closure, summaries, and all three modes before claiming PR #4565 behavior complete.

## Risks

- This is an explicit framework extension: a new input protocol, registry, context, publication phase, and reader. It is not merely another callback.
- Target-local State does not automatically make business updates local. The Definition must distinguish content growth from structural changes and index the affected ranges.
- Node order and visibility have one owner: the Builder. Grouping must not independently sort raw events or infer membership again in infrastructure.
- Stable mounting does not eliminate layout, paint, or retained-memory costs. No measured latency or optimal-performance claim is made.
- Real group splits, merges, first-member changes, and pagination repairs can change identity. The mode-switch guarantee does not prohibit those legitimate changes.
- Revealing hidden parts, selection/copy, interruption notices, group disclosure, and outer Turn interaction require business adaptation. Foundation tests exercise mixed references without enabling production groups.
