# Agent Note: Chat work-details migration progress

Status: proposed

English | [中文](2026-09-20-chat-work-details-migration.zh.md)

## Problem

PR #4565 combines three display modes, process grouping, whole-Turn status, trigger notifications, tool-row visuals, and infrastructure-row hiding. Migrating it as one batch mixes independent features with list restructuring and makes individual performance changes difficult to assess. A feature-based progress table allows independent visuals to be reviewed first and Turn-related behavior to be considered with step-group later, without losing product requirements.

## Proposal

Completed independent features stay in `feat/chat-presentation-channel`. The remaining unfinished code continues in `.artifacts/worktrees/pr-4565-turnstep` under the repository root, based on the current channel and this progress record, with drafts kept unstaged for combined turn/step and grouping review. The `pr-4565` worktree remains the original PR's behavior and implementation reference; existing `feat/chat-step-groups` experiments are outside this transfer.

This record tracks feature scope, current implementation, and acceptance progress. The [presentation policy channel and process-group architecture](../architecture/2026-09-20-chat-presentation-policy-and-step-groups.md) retains the architecture and alternatives. This record neither replaces it nor treats its proposals as implemented. Because it does not fully supersede that decision, retain the architecture note without archival or deletion.

This record maintains an English/Chinese pair. Completion, implementation, staging or commit state, and acceptance are separate dimensions. Incomplete items remain marked incomplete even when drafts exist, and stay in the inventory. Tests and documentation are added during CI repair; browser snapshots and performance acceptance are tracked separately. Written code, staging, commits, and successful builds do not establish complete functional or performance acceptance.

### Status definitions

| Dimension | State | Meaning |
|---|---|---|
| Completion | Complete | Migration code has been reviewed feature by feature and committed to this channel; behavior and performance evidence are separate |
| Completion | Incomplete | Outside the channel's completed migration scope; may have an unstaged draft or no implementation |
| Implementation | Existing capability | Already present in this channel |
| Implementation | Code written | Implementation exists in the relevant worktree; does not imply completion, staging, commit, or acceptance |
| Implementation | Awaiting migration | Included in non-grouping scope but not yet implemented |
| Implementation | Grouping phase | Requirement retained; depends on grouping structure or interactions and is not connected to this channel yet |
| Staging or commit | Unstaged | Changes remain in the worktree, including untracked files |
| Staging or commit | Partially staged | Only some feature changes are staged; the exact scope must be stated |
| Staging or commit | Staged | All pending code changes for the feature are staged but not committed |
| Staging or commit | Committed | Feature code is included in current HEAD |
| Acceptance | Pending | Requires behavior, node identity, update-scope, or browser performance evidence; Git state and compilation cannot substitute |

Verify staging against the feature's diff hunks, not whole files. Inspect the worktree, index, and HEAD when updating status. Staging some fields in a shared file does not stage every feature depending on that file.

### Capabilities already in this channel

| Capability | compact | detailed | expanded | Completion | Implementation | Staging or commit | Acceptance |
|---|---|---|---|---|---|---|---|
| Three settings and legacy-value reading | Compact | Detailed; legacy `normal` reads as this mode without write-back | Expanded | Complete | Existing capability | Committed | Pending |
| Per-Turn folding eligibility | A closed Turn with its start loaded and a final reply can fold process content; cancellation/failure extensions are item 6 | Same | Same | Complete | Existing capability | Committed | Pending |
| Collapsed settled-reasoning summary | Think title only | First line | First line | Complete | Existing capability | Committed | Pending |
| Retain summary DOM across mode changes | CSS hides summary and separator | Show existing summary and separator | Same | Complete | Existing capability | Committed | Pending |
| Local reasoning-preview subscription | `ReasoningRow` selects its own visibility | Same | Same | Complete | Existing capability | Committed | Pending |
| Stable disclosure-row references | Callbacks, icons, and unchanged summaries retain references; full Markdown mounts only on expansion | Same | Same | Complete | Existing capability | Committed | Pending |

All three modes retain whole-Turn folding. `expanded` removes group-level folding, headers, and height limits while retaining group identity and member parents; it does not disable whole-Turn folding or automatically expand reasoning and tool-card bodies. Until grouping is connected, Chat presents `detailed` and `expanded` identically.

### Migration inventory without grouping dependencies

“All three modes” means the behavior applies in every mode, not that switching modes changes it. “Without grouping dependencies” means the draft introduces no step-group, not that every item must be accepted before grouping. Numbers follow the feature review inventory; item 0's compilation wiring is complete and committed, so it is not listed as a product feature. Incomplete drafts remain in `pr-4565-turnstep`, outside this channel's completed features. Behavior and performance acceptance remain pending for the features below.

| Number | Feature | compact | detailed | expanded | Completion | Implementation | Staging or commit | Destination and considerations |
|---|---|---|---|---|---|---|---|---|
| 1 | Chinese tool titles | All three modes | All three modes | All three modes | Complete | Code written | Committed | Bash/Pwsh: “运行命令”; Grep: “搜索文件内容”; Glob: “查找文件”; Skill: “加载技能”. Only UI dictionaries change; model tool names do not |
| 2 | Tool-row interaction visuals | All three modes | All three modes | All three modes | Complete | Code written | Committed | Hover darkens titles and summaries in tool, Bash, and command rows; shared `DisclosureRow` and independent Bash rows point the expanded chevron upward |
| 3 | Bash stopped-state screen-reader text | All three modes | All three modes | All three modes | Complete | Code written | Committed | Complete the stopped-state accessible name without changing execution or cancellation semantics |
| 4 | Running tool/command text shimmer | All three modes | All three modes | All three modes | Complete | Code written | Both 4A shimmer and 4B accompanying optimizations committed | 4A includes a fixed `TextShimmer` span, CSS activation, tool/command integration, replacement of old sweep styles, and reduced-motion support, excluding step/turn. 4B adds business-row computation caches, stable callbacks, and JSX references |
| 5 | Streaming reasoning summary | Update after a paragraph's first line completes | Same | Same | Complete | Code written | Committed | `ReasoningRow` retains the original PR's `latestCompletedParagraphFirstLine(text)` and computes from full text. Retain summary DOM, stable props, and right-edge fading; add no Definition parsing state or cross-layer summary fields |
| 6 | Keep process expanded after cancellation/failure | All three modes | All three modes | All three modes | Incomplete | Draft code written | Unstaged | Draft uses `keepOpen` in Turn process projection; folding eligibility and stopped/failed behavior await Turn/grouping review |
| 7 | Whole-Turn status and duration control | All three modes | All three modes | All three modes | Incomplete | Draft code written | Unstaged | Draft anchors the control to loaded `turn/start` after opening inputs, isolates timing in `LiveTurnProcessLabel`, and replaces the bottom activity bar; positioning and status await review |
| 8 | Non-human trigger notifications | All three modes | All three modes | All three modes | Incomplete | Draft code written | Unstaged | Draft identifies waking inputs from next-turn and first-step next-step claims and projects `turn-trigger`; Turn starts, notification ownership, and expanded content await review |
| 9 (permission/system) | Hide permission-command and system-prompt rows | All three modes | All three modes | All three modes | Complete | Code written | Committed | `isVisibleChatNode` centralizes filtering for the existing Chat list, navigation, and process presentation. Command and request-prompt Definitions do not own these filters; persistence and Trajectory are unchanged |
| 9 (context) | Hide ordinary Context rows | All three modes | All three modes | All three modes | Incomplete | Draft code written | Unstaged | Paired with item 8's waking notifications to retain source explanations; final filter ownership awaits Turn/grouping review |
| 10 | Turn action-bar positioning | All three modes | All three modes | All three modes | Incomplete | Draft code written | Unstaged | Draft anchors `turn-tail` after `turn/end`; reply ownership for feedback/copy and the real Turn-end seq for branching await combined review |
| 11 | Action-bar persistent visibility | All three modes | All three modes | All three modes | Incomplete | Draft code written | Unstaged | Draft projects `footer` per Turn in the Chat builder: persistently visible when the latest Turn ends in a reply, otherwise on hover/focus; tail detection will be considered with grouping |

The current base already enables developer tools by default; do not migrate that again. Retain the protection that waits for Host acceptance of settings instead of applying the original PR's missing-value fallback. Its `Switch` change only affects a comment and is not a migrated feature.

### Subsequent review batches

Review batches are independent of implementation and staging status. Review remaining drafts in `pr-4565-turnstep`, kept unstaged; a draft does not complete a migration. Transfer only this channel's remaining code, without automatically incorporating `feat/chat-step-groups` experiments or installing dependencies and compiling in the destination worktree.

| Batch | Features | Review scope |
|---|---|---|
| Independent feature, committed | 4A: text shimmer | `TextShimmer`, row integration, and browser painting cost; performance acceptance pending |
| Independent optimization, committed | 4B: accompanying memoization and reference stability | `ToolRow`, `BashRow`, and `GenericCommandCard` computation caches, callbacks, and JSX references; not required for shimmer itself; performance acceptance pending |
| Independent feature, committed | Permission-command and system-prompt hiding from item 9 | Retain the original PR's centralized visibility decision; without step-group, the main list connects it in `orderedVisibleChatNodes`, independent of waking-message classification |
| Incomplete, transferred to turnstep worktree | 6, 7, 10, 11 | Whole-Turn folding eligibility, status/clock, action-bar position, and tail detection, considered with Turn/group relationships |
| Incomplete, transferred to turnstep worktree | 8 and ordinary Context hiding from item 9 | Trigger notifications depend on Turn starts and Inbox claims; Context hiding accompanies notifications so waking reasons remain visible |

### Requirements retained for the grouping phase

All items below remain incomplete and retain their full requirements for the turn/step and grouping phase. The [Definition-owned grouping foundation](../../implemented/architecture/2026-09-21-conversation-build-groups.md) is implemented; that does not establish completion of these product behaviors or performance requirements.

| Feature | compact | detailed | expanded | Current state |
|---|---|---|---|---|
| Consecutive process groups between replies | Group tools and reasoning, initially collapsed | Same | Show process rows without group-level folding; retain member parents | Incomplete (grouping phase) |
| Independent reasoning/reply visibility within one Assistant | Reasoning may join the preceding group; reply stays visible | Same | No secondary group hiding | Incomplete; do not directly copy the original split into two render nodes |
| Header category summary | Current category while running; aggregate main categories after completion | Same | No header | Incomplete (grouping phase) |
| Running header details | Hidden | Show command, path, query, etc.; reasoning summary when no tool is running | No header | Incomplete (grouping phase) |
| Header update cadence | Preserve category title's minimum display duration | Also handle detail updates | Not applicable | Incomplete (grouping phase) |
| Height-limited scrolling within a group | Limit expanded height, scroll independently, fade edges | Same | Not applicable | Incomplete (grouping phase) |
| Group and whole-Turn folding interaction | Hide groups when the Turn folds | Same | Whole-Turn folding only | Incomplete; retain node identity and separately decide whether internal expansion resets |
| Pagination, streaming settlement, and group identity | Stable existing headers and members; handle partial Turns separately | Same | Show the same business nodes directly | Incomplete (grouping phase) |

Grouping details to verify: completed summaries aggregate at most three categories and use “etc.” beyond three; call counts determine category ordering rather than appearing as header numbers. Detailed-mode live details collapse whitespace and are capped at 160 characters. Titles remain for at least 150ms; retain only the latest update without replaying queued updates. Expanded height is at most the smaller of 400px and half the viewport. Scrollable edges use a 24px fade and preserve interaction with outer scrolling. Retry rows are outside secondary groups. These values describe the original PR's reference behavior, not completed grouping experiments.

### Definition-owned segmentation and presentation

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

Group headers select data independently from member arrays. All modes retain the same Group container and member parents:

| Mode | Group header | Body |
|---|---|---|
| Compact | Short activity summary | Group open/closed state controls visibility. |
| Detailed | Summary plus live command/path/query details | Same group open/closed state. |
| Expanded | Hidden | Visible without group-level collapse or height cap; wrapper remains. |

This assumes the outer Turn process is open. Expanded retains whole-Turn folding and individual tool/reasoning disclosure; it must not eagerly mount all full Markdown. Turn-close resets of internal state are explicit business actions, not key changes. Group headers, scrolling/fades, and Turn interaction belong to this business integration.

| Business implementation | Responsibility |
|---|---|
| process-groups.ts and register.ts | Definition-owned segmentation, membership, caches, summaries, and registration. |
| AssistantNodeView, Group seat, stores, navigation | Interpret parts; group header/body presentation; local open state; Turn/group reveal, selection/copy and interruption ownership. |

## Performance constraints

| Scenario | Property to preserve | Required evidence |
|---|---|---|
| Switching among modes | Business-node keys do not change; modes do not re-register Definitions; only relevant visibility/presentation fields update | Node identity and update-scope checks |
| Incremental reasoning/tool content | Update only the owning node without scanning full history; compute reasoning summary from current full text during rendering | Update scope and long-text cost; the current summary algorithm does not reduce `ReasoningRow` render count |
| Whole-Turn running clock | Only live clock content updates each second, without refreshing members, historical rows, or list | Update scope and timer disposal |
| Summary visibility | Keep lightweight summaries mounted; do not mount every full Markdown body for mode switching | DOM identity, initial loading, memory observations |
| Pagination | Update new nodes and nodes with changed facts; completed Turns do not refresh together because of global pagination state | Multi-page interaction and update-scope checks |
| State transitions | Stable text/icon/callback references when content is unchanged; do not clear internal state through remounting | Interaction state and component lifecycle checks |

Retaining DOM reduces mounting and unmounting cost, not style calculation, layout, or painting, and can increase retained memory. Changing display properties alone is not a guarantee against jank. The aim is lower switching peaks with acceptable initial-load, pagination, and streaming costs.

## Alternatives considered

**Replay the original PR as one batch.** Rejected: grouping, node splitting, whole-Turn status, and independent visuals would mix, obscuring each feature's performance effects and overwriting local subscriptions and node reuse already completed in this channel.

**Unmount and recreate summaries or process nodes on mode changes.** Rejected for summary mode changes. Stable mounts allow repeated switching to change only display state; initial costs for new nodes still require separate validation.

**Keep every Markdown body mounted for smooth switching.** Rejected: lightweight summaries and full bodies differ in memory, DOM, and rendering cost. Bodies remain mounted according to manual expansion.

**Remount renderers when folding a Turn to reset tool cards.** Do not migrate directly. It conflicts with stable nodes and preserved interaction state. If reset behavior remains necessary, define its state owner and trigger explicitly.

## Acceptance criteria

Update implementation, staging, and commit status separately as work progresses. Completion follows feature review and commits; acceptance follows actual validation. Retain incomplete items across branch splits and worktree transfers. Before grouping work starts, check every product requirement and mode mapping above.

| Acceptance item | Current state |
|---|---|
| Complete behavior validation of existing channel capabilities | Relevant unit and browser regressions pass; this excludes unmigrated grouping features and does not establish performance acceptance |
| Non-grouping feature migration | Completed scope is in the inventory; incomplete drafts await review in `pr-4565-turnstep`; functional and performance validation remain incomplete |
| DOM identity and update scope during mode changes | Unit tests verify summary/expanded-body DOM identity and policy-field subscriptions; browsers verify persistence of all modes and whole-Turn folding; whole-page update scope and performance remain pending |
| Long-session initial loading, pagination, streaming, and memory | Pending; the original PR's historical measurements do not validate this implementation |
| Unit, browser, and recorded-snapshot coverage | 785 relevant unit tests pass; read-only replay of 35 browser files yields 178 passing tests and 4 conditional skips; UI expectations are updated and Session JSONL is unchanged |
| Grouping and the Detailed/Expanded distinction | Incomplete (grouping phase) |

Validation evidence: after rebasing onto master, this channel passed full `pnpm run build`, lint, duplication checks, and all 41 documentation checks. New presentation policy, shimmer, and visibility filtering, plus the settings and Skill rows reported by CI, pass 100% coverage checks over their selected source scope. Test repairs, UI snapshots, and bilingual pairing are committed together as CI fixes. No install, build, or tests ran in `pr-4565-turnstep`; this channel's results do not establish acceptance for that worktree. A real-model GUI demo and performance measurements remain outstanding.

## Risks

- `expanded` and `detailed` currently present identically; the original PR's distinction exists only after grouping is implemented.
- Whole-Turn duration replaces the existing tool/message-count title, changing product information. Migration must preserve status, accessible names, and Turns with no process content, not merely restyle the control.
- Hiding ordinary Context before adding trigger notifications removes background waking reasons; connect both items in the inventory's order.
- The original footer decision depends on grouping indexes. Rework ownership per feature rather than introducing the whole grouping infrastructure for a footer.
- Group identity, membership, and builder materialization in the experiments still require evaluation; this record does not treat the experiment as final architecture.
