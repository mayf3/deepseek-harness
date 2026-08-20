# Agent Note: Exclusive workspace groups and shared task board

Status: implemented

English | [中文](2026-08-21-workspace-exclusive-groups-and-board.zh.md)

## Problem

Browser-local `tags?: string[]` lets one session appear in several tag sections. That works as filtering but not as a task board: cards are duplicated, cross-column dragging has no single meaning, and vertical order cannot have one authoritative account. The product needs Feishu-style task management where each task belongs to one group, each column is one group, and cards move across columns or reorder vertically.

## Decision

**User organization is one exclusive group.** `SessionMeta.group?: string` is the sole assignment; absence means Unassigned. `knownGroups` preserves explicitly created groups with no tasks. Group names are trimmed, NUL-free, and limited to 32 characters. Model-authored todo `tags` remain model data and never reorganize the sidebar or board.

**The group list and board share metadata and order accounts.** `group:<name>` and the Unassigned account own expansion and Session order. The By group list renders each session once. The board renders one column per group plus a permanent Unassigned column. Cross-column dragging calls `setSessionGroup` and updates source and target orders; same-column dragging updates only that order. Removing a group atomically clears `knownGroups`, matching Session assignments, expansion, and order records, returning tasks to Unassigned.

**The board is a controlled full-width Modal owned by WorkspaceBrowser.** A sidebar-header button opens it; clicking a card opens the Session and closes the board. The board derives from the Session list and WorkspaceViewStore rather than owning a second business-state copy. Search, unread, archive, and waiting-parent behavior remain owned by their existing object-layer or browser-local state.

**v6 tag data migrates once to v7.** Existing `dsh.workspace.view.v7` always wins. Otherwise each v6 `tags` array contributes its first valid item as `group`, `knownTags` stable-dedupes into `knownGroups`, and `tag:*` expansion keys map to `group:*`; Workspace/flat order, parent, and unread state survive. Migration writes v7 synchronously and retains v6 for rollback. Invalid JSON or unavailable storage falls back to v7 defaults.

## Alternatives considered

**Keep multiple tags and duplicate cards across columns.** Moving would have to choose among move, copy, or source-tag removal, while one task would keep several unrelated vertical orders. This conflicts with exclusive task-group semantics.

**Add a separate `boardGroup` while keeping user tags.** That would create two similar organization fields and edit paths without a consumer that requires browser-local multi-tagging.

**Let the board own card copies.** This would allow the sidebar, board, and Session list to diverge. The board must remain a pure projection of Session state and WorkspaceViewStore.

## Consequences

Grouping and card order persist only in this browser profile; they do not enter the Session log, synchronize through the Host, or affect model-visible context. Migrating a session with several legacy tags intentionally keeps only the first valid tag, while the retained v6 record allows manual rollback. The board and left group view stay consistent because both mutate the same metadata and order accounts; adding another grouping surface must consume those accounts rather than introduce new state.

## Related notes

This decision partially supersedes [2026-08-16-workspace-tag-grouping-and-nesting.md](2026-08-16-workspace-tag-grouping-and-nesting.md): multi-tag metadata and tag grouping are replaced; waiting-parent nesting, middle-zone attachment, and context menus remain active. It also partially supersedes [2026-08-16-workspace-unread-and-tagview-actions.md](2026-08-16-workspace-unread-and-tagview-actions.md): tag fields and tag-view wording are replaced; unread state, deep-link scrolling, archive controls, and notifier decisions remain active.
