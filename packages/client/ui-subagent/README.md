# @deepseek-ai/dsh-client-ui-subagent

English | [中文](README.zh.md)

Web subagent feature owner: contributes the lazily expandable catalog tree to `conversation.session.header.actions` and reason-specific read-only replacements to the conversation composer chain. The combined Host-backed `@file` and `@session` source belongs to [`ui-reference`](../ui-reference/README.md); this package registers no slash source.

The header action reads `subagentsByParent` and session summaries through the standard `useSessions` hook. After a non-empty direct catalog arrives, its trigger counts the complete subagent-only descendant lineage, stops at ordinary forks, and shows ongoing activity when any counted descendant is running. The compact tree remains direct-catalog authoritative: continuable and one-shot rows display mode plus `running`/`inactive` activity and an optional log-backed title, while the trailing column stacks total durable provider usage above active-turn duration. Token totals sum the four disjoint `tokenUsage` buckets. Visual duration stays exact to the second below one day, then uses at most two adjacent units—days/hours, approximate months/days, or approximate years/months—while hover and the accessible name retain the exact day/hour/minute/second value. Duration sums completed `subagentTiming` turns, advances once per second only for an open turn on a running child, and freezes after the child becomes inactive; an interrupted open turn is bounded by its same-cut `active.through`, never by newer session metadata. An unlabeled one-shot row falls back to its session id, while corrupt, unsupported, or unavailable rows remain readable but disabled. Each healthy row's `hasChildren` hint determines disclosure before interaction, so known leaves never show an arrow; a catalog level reserves the disclosure column only when at least one healthy row is a branch, allowing branchless levels to start at the leading status marker. Expanding a branch immediately reserves one disabled loading row per known direct descendant, then lazily replaces them with that child's authoritative catalog. Every visible branch is reported to the runtime so membership frames cause a debounced refresh only where the tree is being consumed. Selecting any depth calls `SessionsService.openSubagent()` with the row's exact `{parentSessionId, childSessionId, mode}` address. Component-local state owns tree visibility, expanded branches, keyboard focus, and the running-duration clock. ArrowRight/ArrowLeft expand and collapse branches; ArrowUp/ArrowDown, Home, End, and Escape navigate or close the tree; closing returns focus to the trigger. Styling uses tokens only.

A one-shot child always elects a read-only composer that identifies the transcript as a completed execution record. A continuable child does so only when its exact parent is unavailable, with copy explaining the recovery path. A continuable child with a live parent keeps the ordinary input chrome, whose Session routes through `subagent.prompt`; running input remains Send because every follow-up joins the child's FIFO inbox, and addressed sessions never expose Stop. This package never receives host context or calls a model-facing tool. The catalog and composer behavior are specified by the [Web subagent conversations Agent Note](../../../.agents/notes/implemented/feature/2026-07-27-web-subagent-conversations.md).

Subagent-origin Session rows are omitted from the ordinary sidebar, so the parent header catalog is their navigation entry point. Ordinary forks remain in the sidebar.

## Model Experience

Indirectly, through the Host `subagent.prompt` RPC this package's continuable-child composer triggers: accepted continuation content becomes a normal FIFO user message, while catalog browsing, child navigation, and persisted transcript viewing add no prompt section or model tokens.

#### KV Cache effect

Append-only. A human follow-up adds tokens only to its new user message; catalog and transcript operations add zero tokens, and this package never edits earlier request tokens.

## Known Limitations and Deferred Work

- **The catalog has no durable outcome** — activity and timing do not distinguish completion, failure, or cancellation, and the UI exposes neither Activation identity nor an authority-safe cancel button.
