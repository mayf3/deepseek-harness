# Agent Note: Session row menu action slot

Status: implemented

English | [中文](2026-09-17-session-row-menu-actions-slot.zh.md)

## Problem

The Session row menu was a closed list of actions owned by `ui-workspace`. A third-party client plugin could add a separate sidebar control, but it could not place an action beside Rename, Fork, and Archive without changing the owning package or copying the menu interaction.

## Decision

`ui-workspace` declares the root-scoped ordered-list slot `sidebar.workspaces.session.menu.action` under its `sidebar.workspaces` registration. Each contribution receives the target `sessionId` and row `displayTitle` (persisted title, project basename, then Session id); the contributing plugin keeps its services and mutations in its own registration closure.

The shared `MenuAction` primitive renders every contributed row inside `Menu`. It owns the same menu-item semantics, keyboard walk, submenu reset, dismissal, focus restoration, disabled state, icon position, and danger styling as owner-defined rows. Dynamic client bundles resolve `ui-primitives` directly from the host's implicit baseline through their loader `require`; they do not declare a runtime dependency or carry a second component protocol.

### Ordering and disclosure

Rename, Fork, and Archive remain a fixed owner-defined group at the top. Contributions form a semantically separated group below them and follow list-slot ordering: lower `order` first, then the live ledger order. Equal-order packaged registrations keep registration sequence; equal-order dynamic registrations use the facade's decreasing shadowing priority, so the newer entry comes first. Priority otherwise selects the active registration inside one reused-id cell and does not override order across distinct ids. The group is visually and accessibly hidden when empty. The existing ellipsis menu remains the only disclosure layer; nested “More…” grouping is not part of the contract.

## Verification

Primitive tests cover selection, dismissal, focus restoration, submenu reset, the semantic separator, and keyboard order. Row tests cover owner props and built-in-before-plugin placement. The assembled Slot runtime test verifies that order remains primary across different priorities. A real Loader/Web scenario installs a dynamic package, opens a seeded Session menu in Chromium, snapshots the assembled menu, selects an action, and verifies dismissal, owner data, and fiber-lifetime cleanup.

## Alternatives considered

**Pass menu descriptors through the slot owner props.** This makes a render slot behave like a second data registry, exposes presentation policy through callbacks, and prevents ordinary slot components from owning their injected services.

**Expose raw menu markup.** That would let plugins drift from the menu's accessibility, focus, and visual behavior. Requiring the shared `MenuAction` keeps one interaction contract for packaged and dynamically loaded contributions.

**Add primary and “More…” slots immediately.** Session actions are already behind the row's ellipsis, and no current action set needs another disclosure level. A second hierarchy would add labeling and keyboard policy before a demonstrated density problem exists.

## Consequences

Plugins can add Session actions without editing `ui-workspace`, while core actions keep a stable position and external conflicts use the slot registry's existing id and priority rules. Every contribution uses the shared `MenuAction`. All plugin actions remain in the secondary row menu until observed scale justifies a new hierarchy.
