# Agent Note: Sidebar Parent Folders

Status: implemented

English | [中文](2026-09-15-sidebar-parent-folders.zh.md)

## Problem

A flat Workspace list makes related projects hard to browse when many directories share one parent. Treating that parent as the owner of every descendant Session would conflict with the Workspace requirement that a member Session's canonical working directory equals the registered path.

## Decision

Parent folders are browser-local viewing state in the existing Workspace store. Each Workspace appears under the most specific selected ancestor or equal path; unassigned Workspaces retain their root positions relative to each other. Selected parents retain addition order, including empty parents. Path comparison respects directory separators and uses Host case spelling. It does not resolve symlink aliases.

The directory picker reports a parent path without creating a Workspace or Session. Project rows retain their current actions and per-account Session ordering. Workspace dragging is restricted to siblings in the same parent. Search-result navigation expands the parent before revealing the Session. Missing parent-folder state in older browser preferences means no grouping; removing a parent never changes Host state.

## Alternatives considered

**Recursive Workspace membership:** this changes the working-directory invariant and makes a Session eligible for multiple accounts. Display grouping needs neither change.

**A Host-persisted folder hierarchy:** this would synchronize organization across browsers but adds records and API operations for a viewing preference. Browser-local persistence matches the requested scope.

**Automatic directory discovery:** this could show projects without a registered Workspace, but adds filesystem listing, refresh, and adoption behavior. The grouping operation consumes the current Workspace list only.

## Consequences

Users can collapse a family of projects without changing Session ownership. Removing a group preserves the independent [Workspace deletion semantics](2026-07-27-workspace-registration-deletion.md). That decision remains active and is not superseded. Groups do not synchronize across browsers, selected parent folders remain one level deep, and symlink aliases require selecting the canonical ancestor.

Pure path tests cover overlapping roots, segment boundaries, POSIX backslashes, and Windows separators. Component tests cover preference restoration, removal, search revelation, and sibling sorting. The Workspace-management browser scenario exercises the real picker and checks that grouping preserves Host registrations and Agent count.
