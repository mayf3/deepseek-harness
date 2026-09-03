# Agent Note: Session search result reveal

Status: implemented
Archived: 2026-09-03

English | [中文](2026-09-03-session-search-result-reveal.zh.md)

## Problem

Selecting a Session search result opened its conversation while leaving the sidebar in the filtered search view. The user could not see where the Session belonged in the normal Workspace hierarchy. Clearing search alone was insufficient because the owning Workspace could be closed, the Session could be hidden beyond the five-row fold, and either grouped or flat navigation could place the row outside the scrollport.

## Decision

[`WorkspaceBrowser`](../../../../packages/client/ui-workspace/README.md) treats result selection as a transition back to normal browsing. It opens the owning Workspace or Ungrouped group, records the target Session id, clears the query, collapses search, and opens the Session. When grouped browsing remounts, the target group starts with its hidden remainder transiently revealed. Flat browsing needs no fold override.

The normal Session row owns completion of the one-shot reveal. A matching mounted row scrolls itself into the nearest visible position and acknowledges the target id, preventing later renders from repeating the scroll. Metadata and content matches use the same transition because both result kinds resolve to a Session id.

## Alternatives considered

**Preserve the query after opening the Session.** This keeps the discovery context but leaves the user in the temporary result list and does not identify the Session's normal location.

**Clear search without opening or unfolding the owning group.** The conversation would open while its selected row could remain hidden, reproducing the missing-location problem in a different sidebar state.

**Persist an expanded-all preference for the group.** One navigation would permanently replace the bounded five-row presentation. The reveal instead expands the remainder only for the current tree mount.

**Scroll from the browser parent.** The parent cannot complete the operation before a folded target row mounts. The row that owns the DOM element performs and acknowledges the scroll.

## Consequences

Selecting a result discards the current query and returns the sidebar to normal browsing. The owning group stays open, and its hidden remainder is visible for that tree mount, so the selected row supplies both hierarchy context and an on-screen location. A later search or ordinary render does not repeat the scroll after acknowledgment.

## Testing

UI tests cover a content-only hit in the sixth position of a closed Workspace, the corresponding transient group expansion and scroll acknowledgment, and the same one-shot scroll in flat mode. The assembled Web navigation test verifies that one click clears search and leaves exactly one selected Session row in the normal tree. The long-conversation browser test opens its seeded Session with that single-click transition.
