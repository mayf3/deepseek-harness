---
description: "Changed files, deliveries, and clickable file references for the Web GUI: the changed-files card and delivery cards a finished turn ends with, the comparison tab each changed file opens, and inline-code links in the closing prose; for users and maintainers of the deliverables experience."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-deliverables

English | [中文](README.zh.md)

## Summary

This package renders the changed-files card a finished turn ends with — the files the turn changed, with the Host's line counts, each opening a Sidebar tab comparing the file at turn start and turn end — plus cards for explicitly delivered files, and links matching inline-code references in the closing prose so a mentioned file opens in the right Sidebar. Listed and linked paths come from the recorded summary, successful mutations, and explicit deliveries, never from the prose. Only the shipped Web patch loads this package; removing its cordis.yml entry removes the guidance, cards, and prose links together.

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

Mount this plugin alongside `ui-conversation` and the Host [workspace-changes](../../deliverables/workspace-changes/README.md) plugin; a finished turn then ends with the changed-files card between the closing message's body and its action footer. Without a served summary — a turn that changed no file, the plugin composed out, or a Host restarted since the turn ran — the card is absent and only deliveries and prose links remain; outside a git repository the summary lists file-tool edits only.

<a id="explicit-deliveries"></a>
### Explicit deliveries

The Web `standard`, `ptc`, and `cordis` presets expose `present` for final files accessible through the Session filesystem, including files created through Bash. Call it with `files: [{ path, description? }]` after creating the files. The [present tool](../../deliverables/tool-present/README.md) owns file-count limits and Session declarations. The closing turn shows one delivery as a full-width card and multiple deliveries in a two-column grid with 10px gaps. A list longer than four files starts collapsed and provides a control that reveals or hides the complete list. Each 60px-high card uses 8px vertical and 10px horizontal inset spacing, a 20px shared `FileTypeIcon` in a 40px frame, 13px filename text, 10px secondary text, and a 12px Open action. It shows the basename and description, or the file type when no description exists; a trailing parenthesized suffix in the description is omitted, and hovering the card replaces that line with the Sidebar-preview action. Clicking the card or the left side of its split Open control previews the file in the right Sidebar. The chevron opens the standard menu for the Host default application plus Show in Finder on macOS, Show in File Explorer on Windows and WSL, or Open containing folder through the default Linux file manager. Matching inline-code references preview the same source files in the right Sidebar; native opening requires an explicit card-menu action. Repeated declaration of a path selects its latest description before the closing reply.

The `present` tool row shows running, delivered, failed, or interrupted status; expanding a settled row reveals its recorded result. The collapsible card grid retains every delivered file. Both menu actions share pending state and show progress, acknowledgement, or an action-specific retryable error. Desktop information is read when delivery cards appear and invalidated on connection replacement; responses from a replaced connection cannot publish metadata. Selecting a native menu action returns keyboard focus to the available Sidebar Open button. Pending actions close the menu until another explicit gesture. A missing desktop disables the Open menu; a failed desktop-information read offers Retry. It requires a desktop and a suitable default application on the serving Host; a remote browser does not open applications on its own device.

### The changed-files card

The card renders the summary the Host serves for the turn's latest `workspace/changes` announcement, read once per announcement through the authenticated summary route; while the read is pending, once the Host answers that the summary is gone, or when it lists no file, there is no card. Its header names the complete changed-file count with the summed added and deleted lines, and each row shows one file's display path with its own counts, “binary” for a binary file, or “too large” for a file the Host did not capture. Rows appear in the recorded display order, so repository files above the working directory and files outside it sort first. Three rows show before a fold; a control below reveals every recorded file and, once expanded, collapses the list again from the bottom. Each row opens its file's comparison in the right Sidebar. With a Host desktop available, the header opens the deepest workspace folder containing the listed files in the file manager through an authenticated Host action that shows the delivery cards' pending and retryable-error states in place of the totals; a completed open shows the totals again. Without a desktop the header is a plain label. The first file section starts 20px below the closing prose, a following explicit-delivery section starts 16px below the card, and the action footer starts 20px below the last file section. Final file deliveries still require `present`.

### The comparison tab

A row opens a `changes-diff` tab addressed by the viewed Session, the announcing event's sequence, and the file's index, titled with the file name; opening the same row again reveals the existing tab. The tab reads the comparison once through the authenticated comparison route and shows the file's path in its header. A text comparison lists its hunks with the old and new line numbers of every line, additions and deletions in the success and error colours, and a note when the file was created or deleted in the turn, when both sides hold the same lines, or when the Host's line comparison timed out and every line shows as replaced. A binary or oversized file, a comparison the Host no longer serves, and a failed read each show one line instead; a failed read offers Retry. With a Host desktop available the header offers opening the file in the default application, with the same pending and retryable-error states as the cards. The comparison is the turn's snapshot of the file, not its current content; the current content opens from the prose links or the Files tab.

### Inline-code links

The closing prose links produced or delivered paths: an inline-code token resolves by exact path, or by being exactly the basename of exactly one such path — a basename two paths share stays inert rather than guessing, so a mention can never open the wrong file. A resolved mention keeps its code chip and takes the markdown sheet's link language, with the full path as its title.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Node half registers the static `ui:deliverable-file-references` system-prompt section asking the model to mention primary files from successful creation or modification calls and to write those and any other changed-file references as Markdown inline code. The browser half registers a wrapper around the changed-files card and explicit deliveries into the chat view's `conversation.chat.turnTail` hole. `deliverablesDefinition` folds the sequence of each Turn's latest validated `workspace/changes` announcement into `DeliverablesTurnData.changes`, whose summary the card reads from the Host and caches until the connection is replaced, its `deliverables/presented` events into deliveries, and the successful first-party mutation calls of `write`, `edit`, and mutating `str_replace_editor` commands into produced paths from their validated raw arguments; the produced paths feed only the prose mention resolver. Reads, deletes, unsupported tools, malformed calls, malformed events, and failed results contribute nothing. Each row opens `dsh-resource://changes-diff/session/<sessionId>/<seq>/<index>/<display>` through `ctx.sidebarRight.openResource`; the package registers the `changes-diff` tab type at the `builtin` band for that pattern and its body under the keyed `sidebar.right.pane.tab` seat, which reads the comparison through the authenticated comparison route into a store cleared on connection replacement. The package also provides the `chatFileMentions` service the chat view consults per closing message; composing the plugin out removes every surface and leaves the view's empty chain at zero cost.

Native opening uses an authenticated POST addressed by the viewed Session, event sequence, and original file index; the changed-files route omits the index to open the common folder, which the Host derives from the recorded workspace-relative paths and verifies as a directory, and the comparison tab's native open uses the same indexed coordinates. For a declaration the Host reads the viewed Session header with the event and passes its cwd, or the deployment workspace root when absent, to `workspaceFiles.stat`; for a changed file it passes the working directory the served summary carries. This uses the same composed filesystem as Sidebar previews and does not activate an Agent, including for child Sessions. Native actions require the canonical process path to map from a Host path back to that same process path. Providers without this mapping return 422, after which the comparison tab hides its native open; a same-named Host file is insufficient. The same configured desktop availability governs metadata and execution. Edits affect subsequent opens; deletion returns an error. No file-content copy or attachment is created. Plugin disposal cancels and awaits pending native-open requests.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the deliverables surface is not enough. They move from the card to the Host recorder, the turn-tail hole, and the decisions behind the vocabulary.

- [workspace-changes](../../deliverables/workspace-changes/README.md) — the Host plugin that records and serves the summary the card renders.
- [ui-conversation](../ui-conversation/README.md) — declares the `conversation.chat.turnTail` hole and renders the closing prose.
- [Turn changed-files card](../../../.agents/notes/implemented/feature/2026-09-11-turn-changed-files-card.md) — the decision behind git-recorded summaries replacing the mutation-call row.
- [Workspace file links](../../../.agents/notes/implemented/feature/2026-07-31-web-workspace-file-links.md) — the decision behind the earlier produced-files row; its Host open path is superseded by the [right Sidebar](../../../.agents/notes/implemented/feature/2026-09-04-right-sidebar-docking-infrastructure.md).
- [Inline file mentions](../../../.agents/notes/archived/feature/2026-08-07-web-inline-file-mentions.md) — the decision behind clickable mentions in the closing prose.
- [Client package map](../README.md) — adjacent browser UI packages.

-----

<a id="model-experience"></a>
## Model Experience

### Clickable file-reference guidance

#### What the model sees

One fixed paragraph instructs the model to name primary files from successful creation or modification calls in its final response and to format those and any other changed-file references as exact-path or unique-basename Markdown inline code, such as `out/report.html`.

#### Token effect

One fixed prompt paragraph whenever this package is loaded. The [present tool](../../deliverables/tool-present/README.md#model-experience) owns the delivery schema and result text.

#### KV Cache effect

The section is static at first-party order 9000 for the lifetime of the package mount, so it remains in the reusable prompt prefix and does not change across Turns.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the current deliverables vocabulary. They are current package constraints, not a general file-linking comparison or a task backlog.

- **Mention matching is exact path or unique basename only** — a suffix mention stays inert; widening the matcher is deferred until a real closing-message shape needs it.
- **Terminal-created files require explicit delivery** — the card lists them once git records the change, but delivery cards and clickable references still require `present`.
- **Declarations do not preserve file contents** — reopening or transferring a Session requires source files accessible through the viewed Session’s filesystem. Missing files, directories, and final symbolic links return 404.
- **Folder and native opening need a Host desktop** — without one the card header is inert and the comparison tab offers no native open; the comparison itself needs only the Host that recorded the turn.
- **Comparisons are unhighlighted unified diffs** — the tab shows plain hunks without syntax colouring or a side-by-side view, and draws at most 5,000 lines before saying so.
- **Comparisons carry whole file text** — the comparison route serves a listed file's complete text wherever the Host recorded it, including ignored files and files outside the workspace root the Sidebar previews are confined to.
- **Package-local header glyph** — the card's angle-bracket mark lives in `src/client/icons.tsx` until the shared icon set carries it; its props already match the shared icon contract.
- **Files outside the workspace open by absolute path only** — the recorded path is the Host path at recording time; a moved workspace or a different viewing Session cannot relocate it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Prompt, slot, dictionary, file-action route, and optional service registrations are effect-owned; the Session log owns declarations and the filesystem owns file contents.
