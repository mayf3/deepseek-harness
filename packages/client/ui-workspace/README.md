---
description: "Shared Workspace browser and picker plugin for the dsh web client: grouped or flat session rows, add/rename/reorder, search, fork, archive, and the directory-flow picking hole."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-workspace

English | [中文](README.zh.md)

## Summary

This package lets users browse grouped or flat Session lists, choose a Workspace for a new Session, and manage Workspaces and Sessions through add, rename, reorder, search, fork, archive, and Workspace deletion. Pending interactions appear as warning dots, active scheduled tasks as alarm markers, and subagent-origin Sessions remain hidden. Canonically distinct folder paths remain separate Workspaces. Adding a Workspace requires a composed directory picker; without one, the add action is unavailable.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use the sidebar to browse Workspaces and their Sessions, reorder them, and start new ones; use the picker in the Session Intent hero to choose a Workspace for a new session. An open Workspace shows five non-blank Sessions by default and keeps the selected blank **New Session** as one provisional extra row until its first prompt. **Show more** reveals the hidden remainder; closing and reopening the Workspace restores this folded projection.

### Reordering and view options

Pinned Sessions lead ordinary Sessions in both grouped and flat views. **Last updated** sorts each partition strictly by the latest user prompt or steer time, newest first; pin time does not affect it. **Manual** uses the relative positions in one complete Session sequence, including hidden archives. Returning to Last updated discards the manual layout, and entering Manual again freezes the then-current chronological order. The browser defaults to Last updated and remembers the selected mode across reloads.

Pinning moves the Session to the front of its complete saved sequence without changing the selected mode. It leads the pinned partition in Manual but need not lead it in Last updated. Unpinning leaves the saved position unchanged. Dragging either a pinned or ordinary row edits that same complete sequence and selects Manual; hidden archived members are retained. Missing pinned members prepend in pin-array order. New ordinary forks precede their sources in the complete sequence without inheriting pin membership; visible pins still lead ordinary rows. Other missing members append by recency with missing archives last. Supplementation stays in memory until a Session-order write records the complete result. Archive filtering alone changes neither saved positions nor account membership.

The selected blank **New Session** retains its provisional first slot and cannot be dragged; after its first prompt it becomes an ordinary draggable row, retaining that position in Manual or following its current timestamp in Last updated. A collapsed-group drag uses the target Session identity and keeps the source visible. Session display orders for real Workspaces, Ungrouped, and the flat list are browser-local; Workspace group drag order remains Host-durable. The [Session pinning and archive decision](../../../.agents/notes/implemented/feature/2026-09-18-session-pin-and-sidebar-archive.md) records the ordering and recovery rules.

### Workspace hierarchy

Choose **Add workspace** and select a directory to register it and open a Session. **View options → Group by** defaults to **WorkSpace**, which lists Workspaces as sibling sections. Select **Workspace Tree** to nest each Workspace under its nearest registered ancestor, including Workspaces added later. Each Workspace keeps its own Sessions and row actions. Child Workspaces appear before the parent's own Sessions. Ancestors start expanded unless a saved collapsed state exists. A saved collapse also hides the current Session; ancestor folder icons stay highlighted when a descendant Workspace contains it. Row fills and hit targets span the same width at every level; only the contents indent. Workspace dragging reorders siblings; dropping on a descendant targets the nearest compatible ancestor, so an expanded parent can be moved past without collapsing it. Search-result navigation expands every ancestor. Grouping and expansion are saved in the current browser; switching modes preserves each Workspace's expansion preference, and the single-list view stays flat.

Hierarchy uses registered canonical paths only. It does not scan for projects or resolve symlink aliases. Nesting does not change Session working directories, logs, or Workspace membership. Deleting a parent Workspace leaves its child Workspaces registered and places them under their next registered ancestor, or at the root.

### Search

Collapsed search is one header action beside the view and add actions: activating it expands the field across the header. A non-blank query replaces either browsing mode with one flat result list — case-insensitive title and Workspace substring matches appear immediately, while a 250 ms debounced Host request adds ranked current-conversation content matches and snippets. Each new query aborts the preceding request; a failed content search leaves metadata matches visible without an additional warning. The list is capped at 20. Choosing an unarchived result clears and collapses search, opens the Session, and scrolls its row into view in the configured browsing mode; grouped browsing also expands its Workspace and the full Session list when required. Archived results offer Unarchive; attempting to open one explains that restriction without clearing the query or navigating.

### Managing sessions

The Session row's Rename action opens a dialog prefilled with the row's display title; confirming an unchanged title is deliberately allowed — it pins the current automatic title against regeneration. Double-clicking a title also opens Rename; for an unarchived Session, the preceding clicks open its conversation. Rename uses a temporary `workspaceOperation` reference and awaits its initial history opening. The row's Fork action forks at the source's last completed turn and increments the inherited persisted title through Session Controller without retaining the child, opening its history, or changing selection. Workspace Delete opens a confirmation that states the retention boundary; success removes the group while its Sessions remain under Ungrouped.

Archive commits without a confirmation dialog and retains the Session's account position. View options control visibility: the default hides archived Sessions, Show archived includes them, and Archived only hides ordinary Sessions. Visible archived rows are grayed and carry an accessible explanation that they cannot be opened until restored; Rename, Fork, and Unarchive remain available. A successful archive shows a toast with undo and filter-menu actions. Unarchive removes the archive mark without restoring a pin or changing the saved position.

A Session title wider than its row is clipped with an ellipsis at rest. Hovering the row scrolls the title to its far edge — the incremented title of a fork, for example — and reveals it without the ellipsis; leaving the row returns the title to its start.

### Pending interactions

Session rows render the runtime's live `pendingInteraction` classification: approvals report **Waiting for approval**, plan reviews report **Plan awaiting review**, and ordinary questions report **Waiting for answer**. While an interaction is pending, the row uses the shared warning dot and replaces its trailing update time with **Approval**, **Plan review**, or **Answer**; the full status and relative time remain in hover details. Pending interaction takes precedence over the shared ongoing loader; a finished-but-unviewed Session uses done, while idle remains dot-free in the row and uses the shared idle dot in its hover details.

### Active Schedule markers

Grouped and flat Session rows, plus search results, show an outline alarm when `SessionSummary.projectionValues.schedule` is a non-empty array. The marker sits after the title; an ordinary row keeps its update time or compact pending-interaction label after the marker, while a search result has neither trailing value. It is not a button, has no independent pointer action or tab stop, and clicking its area still opens the row. The localized tooltip and matching screen-reader label say **Has active scheduled task**.

The value is intentionally best effort for cold Sessions. An identity-matching usable projection-cache row can prewarm the alarm without opening the Session; a missing or stale cache may briefly omit or retain it. The marker means only that the current list value contains an undispatched or undeleted Schedule record. It does not report whether a Schedule runtime is live or able to wake the Session.

-----

`ctx.uiWorkspace.openSession(target)` synchronously replaces the owned `mainView` reference and returns the main area to Conversation without waiting for `reference.ready`, so history loading renders inside the selected Session view. The target may be a known Session id or a durable direct-parent subagent address; an explicit address does not require a preloaded parent catalog. `openWorkspace(id, beforeOpen?)` opens its result only if no later navigation has superseded the request; New Session uses `openWorkspace`. `forkSession(id)` creates the child without navigating or superseding a pending navigation. The optional synchronous preparation callback runs after the target is retained and only for a current Workspace request, so superseded requests do not move composer drafts. Navigation or owner disposal suppresses the late UI commit, not the underlying Session creation. Startup restoration retains its main reference without changing the selected panel or cancelling a later navigation. Archiving the main Session releases its reference and clears the main selection. Selection failure leaves a global panel visible. Session rows read `usePanelInfo` to suppress their selected appearance while a global panel is active; search and directory-picker focus alone do not leave that panel.

New Session tries to acquire the first eligible blank in catalog order; startup restoration tries the saved blank. If that writer is held, navigation creates a new Session without trying other blanks. Other acquisition failures abort the request and are currently reported only to the console. Released blanks retain their slash-command state when reused. Later navigation cancels a pending startup selection.

`openDefaultWorkspace(request, beforeOpen, signal)` initializes the Host default Workspace from the requested directory name and title before connecting its Session. It captures navigation cancellation before directory preparation; superseded work cannot transfer the draft or select its Session. A successfully registered Workspace remains available when Session creation or later submission fails. [Conversation](../ui-conversation/README.md) owns the first-use draft and failure dialog.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package is one composition: both target slots are declared by other plugins, so `apply` uses `slots.inject()` to register for each declaration lifetime and re-register after a declaring slot is restored.

### The directory-flow hole

Each registration declares a **directory-flow child hole** (`single` kind: `conversation.hero.workspace.directoryFlow` / `sidebar.workspaces.directoryFlow`) that the composed picker package's client half fills with its picking interaction — the `-native` backend's renderless OS-chooser driver, an in-app browsing dialog under a `-browse` composition. The flat **Add workspace...** action renders only while the surface's hole is occupied; an empty hole means the composition has no picking affordance. This package owns the trigger and the adoption: the occupant reports one picked path per open through the hole's owner conversation (`open`/`busy`/`onPicked`/`onCancel`/`onError`), and the owner adopts it through the object layer, selecting the committed Workspace only after its list projection has refreshed.

### View state

Once the Workspace baseline is ready, browser-persisted expansion and Session-order records retain only current Workspace ids plus Ungrouped and the flat-list account. `WorkspaceView.sessionIds` supplies real-Workspace membership, not Session display order. View actions receive complete account orders, never filtered rows. A new member without a Session summary waits for that summary, while a saved position survives a temporarily missing summary. Archive visibility is applied only when deriving rows. Pin and drag writes save complete orders; ordinary derivation does not write them. The selected blank Session remains an explicit position write, including during Workspace reconnection, when other saved members are retained until the baseline establishes membership. Ordering remains mounted while the sidebar is a rail or search replaces its body. Last updated derives from current summaries without reading saved positions; equal timestamps use Session ids as a stable tie-break.

The sidebar hides durable summaries with `origin: 'subagent'`. A visible ordinary row shows the shared ongoing loader from running direct children in its loaded parent catalog, never from summary lineage. Child activity uses the latest UI status, falling back to the Session summary until that status is known. The same pure derivation reads the Schedule key from list projection values for grouped, flat, and search nodes; the package uses only the type-only `@deepseek-ai/dsh-schedule/client` dependency and does not import the Schedule runtime or `ui-schedule`.

Row motion belongs to [AnimatedRows](src/client/rows/AnimatedRows.tsx). It measures keyed rows before and after React commits that change their membership or order, and uses native movement and opacity animations. Removed rows fade as inert copies outside the scrolling list; they do not delay React unmounting or extend its scroll range. Initial loading, drag commits, overflow expansion, and view-option changes settle immediately. The animator has no layout observers or polling and does not measure content-only updates or scrolling.

### Hover cards

Workspace and Session hover cards copy the value their row clips: activating a Workspace card writes its full directory path, while activating a non-blank Session card writes its full display title. A provisional blank New Session card remains read-only because its localized label is a placeholder rather than session content.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the sidebar host, the hero surface, and the picking backends.

- [ui-sidebar](../ui-sidebar/README.md) — the sidebar shell hosting the `sidebar.workspaces` hole.
- [ui-conversation](../ui-conversation/README.md) — the chat surface hosting the Session Intent hero's picker hole.
- [directory-picker-native](../../host/directory-picker-native/README.md) — the OS-chooser backend filling the directory-flow hole.
- [Workspace Controller](../../api/workspace-controller/README.md) — the Host mutations and framework-neutral Client projection that own Workspaces, membership, and Workspace group order.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the search depth, the archive surface, and the picking carrier; they are current package constraints.

- **No fuzzy content search or event deep links** — the content backend uses literal token/phrase matching, and selecting a result opens the Session rather than the matching event.
- **No Session deletion** — sessions can be archived but never deleted; archived rows stay recoverable in place through the archived view filter and the search results' unarchive action, and Workspace registration deletion does not delete Sessions.
- **Pending user interaction is not aggregated into collapsed groups** — a waiting row inside a collapsed group lights no group-header indicator and becomes visible only after that group is expanded.
- **Native folder selection depends on the local Host carrier** — under the `-native` composition, in-process or remote browser deployments cannot open a local operating-system dialog; remote-capable picking is the `-browse` composition's in-app flow.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. This is a pure-consumer plugin that registers presentational components into two host-declared slots and registers its locale dictionaries; its inject face consists of stateless RPC wrappers plus a create-and-open call. It emits no Cordis events and owns no cross-plugin mutable state.
