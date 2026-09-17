# Agent Note: Persistent plan cards and sidebar reading

Status: implemented

English | [中文](2026-09-17-persistent-plan-cards.zh.md)

## Problem

A plan review occupies the composer only until the user answers or dismisses it. A completed Turn also folds its tool calls into the process disclosure. Neither lifetime gives a submitted plan a discoverable place to read while implementation continues.

## Decision

`ui-plan` derives one permanent Chat card from each `exit_plan_mode` invocation, including native calls and PTC dispatches. The card declares `process: 'independent'`, so Chat keeps it outside the Turn process disclosure. Review dismissal, refusal, and approval do not delete it.

The review intent carries the tool-call identity. The question plugin declares an action slot, and the plan plugin contributes an opener there and on the historical card. Both open the resource identified by Session and invocation. Sidebar layout retains that address; the resource provider reads the existing Session history, paging backwards when the invocation is older than the opening window. Its temporary follow closes after the opening snapshot.

The document is read-only. The pending review shows its status, sidebar opener, and decision buttons; the complete text is read in the sidebar. Approval stays in the pending-question owner; reopening a historical document does not revive a settled review or authorize implementation. Different submissions remain distinct even when they share a heading.

## Alternatives considered

**Keep only the pending review or an expandable tool row.** Both hide the document behind unrelated interaction or process state. The user needs a persistent artifact entry.

**Write a Markdown file or persist the document in sidebar layout.** The tool arguments already own the exact submitted text. Another durable copy would need synchronization and could disagree with the reviewed plan. The [plan-state decision](../simplification/2026-07-22-plan-specific-collaboration-state.md) remains the authority for that ownership.

**Teach Chat the plan tool's name.** A node-owned disclosure declaration lets the feature identify its independently readable artifact without adding plan-specific rendering or imports to Chat.

## Consequences

Plans survive review closure and browser reload without a new Session event or file. Reads of old plans may require several history pages. The provider validates saved addresses and logged arguments, and reports unavailable history explicitly. The recorded Web plan-review scenario covers both entry points, repeated opening, process collapse, approval, and reload; focused tests cover native/PTC decoding and resource failures.
