# Agent Note: Session pinning and the sidebar archived filter

Status: implemented

English | [中文](2026-09-18-session-pin-and-sidebar-archive.zh.md)

## Problem

The sidebar session list had no way to keep important sessions at the top, and archived sessions could only be reached through a settings page (`ui-settings-unarchive-sessions`) far from the list they came from. Users archived a session and then lost sight of it.

## Decision

The `dsh-workspace` registry stores a registry-global pin set (`pinnedSessions`, most recently pinned first, each entry carrying its epoch-millisecond `pinnedAt`) beside the existing archive set, with durable `pinSession`/`unpinSession` operations. Pinning and archival are mutually exclusive: archiving drops the session's pin in the same durable write, and pinning an archived session fails with `WorkspaceArchivedSessionPinError`.

The sidebar derives both states in `ui-workspace`:

- Pinned rows lead their section as a partition that never disturbs relative order on either side, so unpinning restores the row's kept slot. Under recency order a pinned row ranks by the later of its pin instant and update recency; under manual order pinned-to-pinned drags hold.
- Archived rows keep their accounting slots, render grayed, and are not openable. The view-options menu owns an `ArchivedFilter` (`default` hide / `show` / `only`) applied to lists and search alike; the settings-page archived list is deleted with its package.
- Archiving raises a toast with undo and filter-archived actions, and a one-time hint anchors under the view-options trigger.
- Row motion uses `@formkit/auto-animate` reserved for pin jumps and archive/unarchive fades; wholesale layout passes (expand/collapse, drag commit, grouping/ordering/filter switches) mute row animations for one frame through `muteNextRowAnimations`.

## Alternatives considered

**Keep the settings-page archived list.** Two homes for one state; the sidebar filter shows archived rows in the browsing context they came from, so the package is removed outright.

**Fold pin position into the persisted manual order.** The order would absorb pin state, so unpinning could not restore the row's previous slot; the partition keeps pin state and row order independent.

**Animate every list pass with auto-animate defaults.** Expanding a group, committing a drag, or switching the filter moves rows wholesale and reads as exaggerated motion; those passes apply instantly and animation stays reserved for single-row pin and archive changes.

## Consequences

The sidebar owns archived visibility end to end and settings loses a package. The pin set is registry-global, so pins survive grouping and ordering switches. `ui-workspace` gains a client dependency on `@formkit/auto-animate`. Unit suites pin the partition, filter, toast, and mute behavior; the workspace Host suite pins pin/archive exclusivity and durability.
