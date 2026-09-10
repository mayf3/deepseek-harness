# Agent Note: Derive Workspace recency independently of manual order

Status: implemented

English | [中文](2026-09-10-derived-workspace-recency.zh.md)

## Problem

An editable activity-promoted list can disagree with its displayed timestamps without a drag: an older Session arriving late is promoted ahead of a newer Session already observed. Repeating the same complete list preserves that inversion. The historical [sidebar-order decision](../../archived/feature/2026-08-11-workspace-sidebar-order-and-folding.md) shared one editable order between Manual and Last updated to preserve positions when switching modes. That trade-off does not satisfy chronological browsing.

## Decision

Last updated is a pure projection of current Session summaries: ordinary rows sort by descending `updatedAt`, with Session id as the tie-break. The selected blank New Session precedes ordinary rows until its first prompt. Grouped, Ungrouped, and flat views use the same policy. Reloads and delayed summaries require no observed-timestamp history or promotion events in the view store.

Only Manual uses the browser-persisted order. A Session drag saves the visible ordering after the move and selects Manual atomically. Real Workspace drags also call the existing Host reorder operation; Workspace-group order remains Host-owned. Returning to Last updated leaves saved manual positions intact. Returning to Manual restores them. Initial manual orders use Host membership order for real Workspaces and recency for Ungrouped and flat lists.

The existing persistence key retains grouping, expansion, and saved positions. Legacy mixed orders remain usable as manual positions but cannot affect Last updated. The obsolete observed-timestamp field has no consumer. Current metadata still owns timestamp accuracy: a cold summary without prompt metadata can fall back to creation time, independently of view ordering.

## Alternatives considered

**Keep activity promotion and sort again on reconnect.** Late summaries and metadata corrections also arrive within a connection. A reconnect-only repair still allows chronology to depend on observation order.

**Persist a second chronological order.** Current timestamps already determine that order. A second ledger retains synchronization and recovery work without representing an independent user choice.

**Disable dragging in Last updated.** Switching to Manual on a committed drag keeps the existing affordance and gives the edited order an explicit mode. A cancelled or ineffective drag leaves the selected mode unchanged.

## Consequences

Manual and Last updated have distinct meanings; switching modes may move rows to their saved manual positions. Chronological browsing gives up persistent drag exceptions. The view store retains manual-order membership reconciliation and blank-row creation placement, but owns no activity timestamps.

The archived sidebar note remains frozen historical evidence; its folding and Workspace-order decisions are outside this change. No active note owns the superseded shared-order policy.

## Testing

Component regressions cover older first arrivals, corrected and decreasing timestamps, saved-order isolation, reloads, and automatic Manual selection on drag. The recorded-session Web scenario exercises the shipped composition with legacy persisted positions, native dragging, grouped and flat views, and reloads. Existing folding cases retain the provisional blank quota.
