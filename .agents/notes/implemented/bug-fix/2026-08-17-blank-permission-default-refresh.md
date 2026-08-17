# Agent Note: Refresh blank session permission defaults

Status: implemented

English | [中文](2026-08-17-blank-permission-default-refresh.zh.md)

## Problem

The Web New Session flow reuses a workspace's blank session instead of minting another hidden placeholder. Permission defaults are pinned into a session at creation time, so changing the General settings permission row after a blank placeholder already existed left that placeholder on the previous preset. The next "new" conversation could therefore reuse a blank session whose permission chip contradicted the newly saved default.

## Decision

`dsh-permission-presets` treats a settings change as a chance to advance reusable blank placeholders. When `defaultPreset` changes, the service scans live sessions, finds sessions that have not started a turn, and switches only those whose effective permission still equals the previous default. Sessions that have started a turn are never changed. Blank sessions the user already switched away from the previous default are also left alone.

This keeps the existing Web blank-session reuse policy intact while making the reused placeholder observe the same default a freshly created session would receive. The update goes through the normal preset setter, so the durable `permission/preset`, `sandbox/mode`, and `approval/policy` facts remain the single source for projections and execution.

This partially refines the earlier [permission default for new sessions](../feature/2026-07-31-permission-default-for-new-sessions.md) decision: started sessions and seeded resumes remain pinned, while unseeded blank placeholders may advance because the Web treats them as New Session reuse targets.

## Alternatives considered

**Disable blank-session reuse after any permission settings change.** Rejected because it would leave extra hidden placeholders and make New Session less deterministic. The existing reuse policy is valuable; only stale permission defaults were wrong.

**Have the client compare a blank session's permission projection with the Settings row.** Rejected because the workspace runtime would need to understand the permission settings namespace or add a cross-plugin hook solely for this case. The permission service already owns the default and can repair its own blank placeholders.

**Update every blank session unconditionally.** Rejected because a user may deliberately switch the current blank session's permission before sending the first prompt. Matching only the previous default updates stale placeholders without overwriting an explicit blank-session selection.

## Consequences

A settings change may append permission facts to unseeded blank sessions, but those sessions remain blank because blankness is defined by the absence of `turn/start`. Started conversations, seeded resumes, and blank sessions with an explicit user-selected preset keep their original permission.
