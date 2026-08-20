# Agent Note: Workspace bulk archive selection

Status: implemented

English | [中文](2026-08-20-workspace-bulk-archive-selection.zh.md)

## Problem

Archiving one Session requires a precise row gesture, and repeating it for many Sessions is slow. A bulk action must preserve the visible list as the user's selection frame, avoid selecting provisional blank Sessions, and keep failures recoverable without hiding which requests need retry.

## Decision

**The Workspace header exposes bulk selection with the archive-box icon.** Bulk mode replaces each nonblank Session row's status and trailing actions with a checkbox. Session opening, dragging, context menus, and hover cards are disabled until bulk mode ends. Blank rows remain visible but cannot be selected.

**Selection follows the currently rendered Session order.** A click toggles one Session. Shift-click adds the inclusive range from the latest anchor to the target in the current visible order. Folding, filtering, or another projection change removes invisible ids from selection; grouping and unread-filter changes clear selection. Starting search exits bulk mode.

**The bottom toolbar owns the complete bulk operation.** It reports the selected count, selects or clears visible rows, cancels bulk mode, and archives through an in-place two-click button. The row archive button uses the same two-click pattern; blur or Escape disarms it without opening a popover.

**Bulk archive fans out the existing operation.** The Client calls `archiveSession` once per selected id through `Promise.allSettled`. All-success exits bulk mode. Partial failure retains only rejected ids, reports success and failure counts, and leaves the toolbar ready to retry. No new Host operation or durable format is introduced.

## Alternatives considered

**A confirmation popover.** Rejected because it detaches confirmation from the initiating control and adds pointer travel for both row and bulk operations. Reusing the focused button keeps the second gesture in place and gives blur and Escape an explicit cancellation path.

**A Host bulk-archive RPC.** Rejected because independent existing requests already provide the required durability and error identity. `Promise.allSettled` preserves per-Session failures without adding wire behavior.

**Retain successful ids after partial failure.** Rejected because those requests have completed; leaving them selected suggests they still need action and makes retry ambiguous.

## Consequences

Bulk selection is transient browser state and follows only selectable rows that remain visible. Partial failures are actionable in place, while all-success returns to ordinary browsing. Focused row and WorkspaceBrowser tests cover confirmation cancellation, interaction suppression, Shift ranges, visibility reconciliation, and partial failure; workspace-management e2e covers the durable archive round trip through bulk mode.
