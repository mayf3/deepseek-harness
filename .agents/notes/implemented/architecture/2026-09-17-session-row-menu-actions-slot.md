# Agent Note: Session row menu action slot

Status: implemented

English | [中文](2026-09-17-session-row-menu-actions-slot.zh.md)

## Problem

The Session row menu was a closed list of actions owned by `ui-workspace`. A third-party client plugin could add a separate sidebar control, but it could not place an action beside Rename, Fork, and Archive without changing the owning package or copying the menu interaction.

## Decision

`ui-workspace` declares the root-scoped ordered-list slot `sidebar.workspaces.session.menu.action` under its `sidebar.workspaces` registration. Each contribution receives the target `sessionId`, the row `displayTitle` (persisted title, project basename, then Session id), and a `dismiss()` callback; the contributing plugin keeps its services and mutations in its own registration closure.

The shared `MenuAction` primitive renders contributed rows inside `Menu`. It owns the same menu-item semantics, keyboard walk, submenu reset, dismissal, focus restoration, disabled state, icon position, and danger styling as owner-defined rows. Import-free dynamic client packages instead render a native `button[role="menuitem"]` and call the owner `dismiss()` after acting.

### Ordering and disclosure

Rename, Fork, and Archive remain a fixed owner-defined group at the top. Contributions form a semantically separated group below them and sort by lower slot priority, lower `order`, then registration sequence. The dynamic browser-half facade gives each registration a distinct decreasing priority, so newer dynamic registrations precede older ones regardless of `order`; packaged registrations at equal priority use `order`. The group is visually and accessibly hidden when empty. The existing ellipsis menu remains the only disclosure layer; nested “More…” grouping is not part of the contract.

## Verification

Primitive tests cover selection, dismissal, focus restoration, submenu reset, the semantic separator, and keyboard order. Row tests cover owner props and built-in-before-plugin placement. The assembled Slot runtime test registers packaged and dynamic-style contributions in reverse order and verifies ordering, display-title identity, dismissal, and trigger-focus restoration.

## Alternatives considered

**Pass menu descriptors through the slot owner props.** This makes a render slot behave like a second data registry, exposes presentation policy through callbacks, and prevents ordinary slot components from owning their injected services.

**Expose only raw menu markup.** That would let packaged plugins drift from the menu's accessibility, focus, and visual behavior. `MenuAction` remains their stable path, while `dismiss()` gives import-free dynamic packages the minimum lifecycle capability they need.

**Add primary and “More…” slots immediately.** Session actions are already behind the row's ellipsis, and no current action set needs another disclosure level. A second hierarchy would add labeling and keyboard policy before a demonstrated density problem exists.

## Consequences

Plugins can add Session actions without editing `ui-workspace`, while core actions keep a stable position and external conflicts use the slot registry's existing id and priority rules. Packaged contributions use `MenuAction`; dynamic contributions own their markup and must call `dismiss()` after acting. All plugin actions remain in the secondary row menu until observed scale justifies a new hierarchy.
