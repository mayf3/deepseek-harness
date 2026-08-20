# Agent Note: Workspace browser tag grouping, waiting-on nesting, and row context menus

Status: implemented

English | [中文](2026-08-16-workspace-tag-grouping-and-nesting.zh.md)

Partially superseded by [exclusive workspace groups and the shared task board](2026-08-21-workspace-exclusive-groups-and-board.md): multi-tag metadata and tag grouping are replaced; waiting-parent nesting, middle-zone attachment, and context menus remain active.

## Problem

The workspace browser groups sessions only by Host Workspace. Cross-directory organization depends on session-title conventions, dependencies between tasks cannot express that one task is waiting on another, and row actions are hidden behind an ellipsis button. Users need configurable tag groups, waiting relationships between tasks, and direct access to row actions through a context menu.

## Decision

**Tags and waiting relationships are browser-local metadata and do not enter the session log.** `WorkspaceViewState` stores `sessionMeta: Record<sessionId, { tags?: string[]; parent?: string }>` and `knownTags: string[]` for explicitly created empty tag groups under the existing persistence key. `deriveTagGroups` reads only user metadata; tags written by the model through `todo_write` do not affect grouping. `waitingOrder` places a child session after its parent and assigns `SessionNode.depth`; any members left by a cycle are placed as roots.

**Attachment and tagging each support drag-and-drop and menu paths.** Dropping on the middle 30%–70% of a session row attaches the dragged session beneath that task, while the upper and lower edges retain ordering semantics. Dropping a nested row between rows detaches it. In tag view, dropping on a tag heading adds that tag and dropping on the untagged bucket clears tags; `ProjectRowItem` receives and highlights the `dropTarget`. The menu retains “Set tags…” while attachment stays a drag interaction.

**Session and workspace rows share a context-menu path.** Both handle `onContextMenu`, suppress the browser menu, and open the row menu. Session rows also offer “New session in this workspace” when their workspace is known.

**`todo_write` accepts optional `tags`.** `TodoItem` includes `tags?: string[]`; the tool schema, description, and projection preserve the field. Writes trim, remove empty and duplicate labels, accept at most eight labels, and limit each label to 32 characters. The data remains available for consumers, while workspace grouping stays user-managed.

## Alternatives considered

**Derive workspace groups from `TodoItem.tags` in the session log.** Rejected because model-authored labels add incidental groups and the client cannot safely append session events. Browser-local metadata represents explicit user organization without changing the Host.

**Build a separate directory-style dependency tree.** Rejected because middle-row attachment and nested rows extend the existing row model, while another tree would duplicate its rendering and interaction structure.

## Consequences

Workspace organization persists locally and remains independent of replayed model output. Users can group sessions and express waiting relationships without changing session-log semantics, but those relationships do not synchronize through the Host and model-written todo tags do not reorganize the browser.
