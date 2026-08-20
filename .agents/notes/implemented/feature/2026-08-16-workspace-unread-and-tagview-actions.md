# Agent Note: Workspace unread state, tag-view session creation, and persistent expansion

Status: implemented

English | [中文](2026-08-16-workspace-unread-and-tagview-actions.zh.md)

Partially superseded by [exclusive workspace groups and the shared task board](2026-08-21-workspace-exclusive-groups-and-board.md): tag fields and tag-view wording are replaced; unread state, deep-link scrolling, archive controls, and notifier decisions remain active.

## Problem

The workspace browser has three related gaps. Tag view cannot create a session in the selected row's workspace because tag groups have no workspace identity. Sessions have no user-controlled unread state. Tag-group expansion also resets because workspace-key pruning removes `tag:*` and `UNTAGGED_KEY` entries from `groupExpansion` whenever the workspace baseline changes.

## Decision

**“New session in this workspace” follows the session row's workspace.** `SessionNode` carries an optional `workspaceId`. `deriveGroups` passes the group workspace directly, while `deriveTagGroups` and `deriveFlat` receive `workspaces` and build a session-to-workspace map. The row menu reads `node.workspaceId`, making the action available in workspace, tag, and flat views when ownership is known.

**Unread state is browser-local metadata persisted in `sessionMeta`.** `SessionMeta` includes `unread?: boolean`, and `setSessionUnread` updates it. Derived rows expose `SessionNode.unread`; the title renders an 8 px brand-color dot with an accessible unread label. The context menu toggles the state, and opening a session clears it. Search results omit unread treatment because they are transient.

**Tag-group expansion survives workspace pruning.** `retainAccountKeys` preserves keys with `TAG_GROUP_PREFIX`. The preservation belongs in the store action: adding `groupExpansion` to the browser effect dependencies would retrigger the effect whenever retention creates a new object identity.

**Tags support whole-tag deletion and autocomplete.** `removeTag(tag)` removes the tag from all session metadata, `knownTags`, and the corresponding `tag:<name>` expansion key. Tag headings expose a destructive “Delete tag” context-menu action. Session-tag editing and new-tag dialogs share a datalist built from `knownTags` and session metadata, deduplicated and sorted.

**A row-created session inherits the source row's tags.** `startSession` does not return the new session id, so `SessionTree` and `FlatList` retain `{ workspaceId, tags }` before the call. An effect applies those tags once the blank session in that workspace becomes current, then clears the pending record; a session from another workspace is never tagged.

**Unread filtering and deep-link scrolling are persistent view behavior.** `unreadOnly` is stored with the view state. Workspace, tag, and flat derivations remove read rows and hide empty groups while the filter is active. Session rows expose `data-session-id`; a current-session change polls for that row and calls `scrollIntoView({ block: 'nearest' })`. Tag view expands the current session's tag groups before scrolling.

**The inline row action is archive; other operations use the context menu.** The archive icon uses the in-place two-click confirmation owned by [workspace bulk archive selection](2026-08-20-workspace-bulk-archive-selection.md). Rename, fork, tags, unread state, and session creation remain in the row context menu, positioned from the recorded pointer coordinates.

## Alternatives considered

**Merge tag keys into `retainAccountKeys` in the caller effect.** Rejected because the effect would depend on `groupExpansion`, while retention creates a new object identity and can cause a maximum-update-depth loop. Keeping the rule in the store action preserves one update boundary.

**Store unread state on the Host session.** Rejected because the session model has no unread property and unread state is browser presentation metadata alongside tags and parent relationships.

**Require users to clear unread state manually.** Rejected because opening the session is the acknowledgement point and matches completed-notification behavior.

## Consequences

The three workspace views share session creation and unread behavior, tag expansion persists across refreshes and workspace changes, and deep links reveal the selected row. These preferences remain local to the browser profile. Creating a tagged session relies on observing the newly current blank session because the creation API does not return its id.

## Related

This decision extends [workspace tag grouping and nesting](2026-08-16-workspace-tag-grouping-and-nesting.md). It reuses that decision's context-menu and local-metadata mechanisms without replacing them.
