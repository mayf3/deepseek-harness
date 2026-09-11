---
description: "Changed files, deliveries, and clickable file references for the Web GUI: the changed-files card and delivery cards a finished turn ends with, and inline-code links in the closing prose; for users and maintainers of the deliverables experience."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-deliverables

English | [中文](README.zh.md)

## Summary

This package renders the changed-files card a finished turn ends with — the files the turn changed, with the line counts the Host recorded from git snapshots — plus cards for explicitly delivered files, and links matching inline-code references in the closing prose so a mentioned file opens in the right Sidebar. Listed and linked paths come from the recorded summary, successful mutations, and explicit deliveries, never from the prose. The shipped Web patch is the only composition that loads this package; removing its cordis.yml entry removes the guidance, cards, and prose links together.

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

Mount this plugin alongside `ui-conversation` and the Host [workspace-changes](../../fs/workspace-changes/README.md) plugin; a finished turn then ends with the changed-files card between the closing message's body and its action footer. Without a recorded summary — a workspace outside any git repository, no git on the Host, or the plugin composed out — the card is absent and only deliveries and prose links remain.

<a id="explicit-deliveries"></a>
### Explicit deliveries

The Web `standard`, `ptc`, and `cordis` presets expose `present` for final files accessible through the Session filesystem, including files created through Bash. Call it with `files: [{ path, description? }]` after creating the files. The [present tool](../../fs/tool-present/README.md) owns file-count limits and Session declarations. The closing turn shows one delivery as a full-width card and multiple deliveries in a two-column grid with 10px gaps. A list longer than four files starts collapsed and provides a control that reveals or hides the complete list. Each 60px-high card uses 8px vertical and 10px horizontal inset spacing, a 20px shared `FileTypeIcon` in a 40px frame, 13px filename text, 10px secondary text, and a 12px Open action. It shows the basename and description, or the file type when no description exists; a trailing parenthesized suffix in the description is omitted, and hovering the card replaces that line with the Sidebar-preview action. Clicking the card or the left side of its split Open control previews the file in the right Sidebar. The chevron opens the standard menu for the Host default application plus Show in Finder on macOS, Show in File Explorer on Windows and WSL, or Open containing folder through the default Linux file manager. Matching inline-code references preview the same source files in the right Sidebar; native opening requires an explicit card-menu action. Repeated declaration of a path selects its latest description before the closing reply.

The `present` tool row shows running, delivered, failed, or interrupted status; expanding a settled row reveals its recorded result. The collapsible card grid retains every delivered file. Both menu actions share pending state and show progress, acknowledgement, or an action-specific retryable error. Desktop information is read when delivery cards appear and invalidated on connection replacement; responses from a replaced connection cannot publish metadata. Selecting a native menu action returns keyboard focus to the available Sidebar Open button. Pending actions close the menu until another explicit gesture. A missing desktop disables the Open menu; a failed desktop-information read offers Retry. It requires a desktop and a suitable default application on the serving Host; a remote browser does not open applications on its own device.

### The changed-files card

The card renders the turn's latest `workspace/changes` event: its header names the complete changed-file count with the summed added and deleted lines, and each row shows one file's display path with its own counts, or “binary” for a binary file. Rows appear in the recorded display order, so repository files above the working directory and files outside it sort first. Three rows show before a fold; a control below reveals every recorded file and, once expanded, collapses the list again from the bottom. With a Host desktop available, the header opens the deepest workspace folder containing the listed files in the file manager and each row opens its file in the default application, both through authenticated Host actions that share the delivery cards' pending, acknowledged, and retryable-error states in place of the counts. Without a desktop the header is a plain label and rows preview their files in the right Sidebar. The first file section starts 20px below the closing prose, a following explicit-delivery section starts 16px below the card, and the action footer starts 20px below the last file section. Final file deliveries still require `present`.

### Inline-code links

The closing prose links produced or delivered paths: an inline-code token resolves by exact path, or by being exactly the basename of exactly one such path — a basename two paths share stays inert rather than guessing, so a mention can never open the wrong file. A resolved mention keeps its code chip and takes the markdown sheet's link language, with the full path as its title.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Node half registers the static `ui:deliverable-file-references` system-prompt section asking the model to mention primary files from successful creation or modification calls and to write those and any other changed-file references as Markdown inline code. The browser half registers a wrapper around the changed-files card and explicit deliveries into the chat view's `conversation.chat.turnTail` hole. `deliverablesDefinition` folds each Turn's latest validated `workspace/changes` event into `DeliverablesTurnData.changes`, its `deliverables/presented` events into deliveries, and the successful first-party mutation calls of `write`, `edit`, and mutating `str_replace_editor` commands into produced paths from their validated raw arguments; the produced paths feed only the prose mention resolver. Reads, deletes, unsupported tools, malformed calls, malformed events, and failed results contribute nothing. The package also provides the `chatFileMentions` service the chat view consults per closing message; composing the plugin out removes both surfaces and leaves the view's empty chain at zero cost.

Native opening uses an authenticated POST addressed by the viewed Session, event sequence, and original file index; the changed-files route omits the index to open the common folder, which the Host derives from the recorded workspace-relative paths and verifies as a directory. The Host reads the viewed Session header with the declaration or summary and passes its cwd, or the deployment workspace root when absent, to `workspaceFiles.stat`. This uses the same composed filesystem as Sidebar previews and does not activate an Agent, including for child Sessions. Native actions require the canonical process path to map from a Host path back to that same process path. Providers without this mapping return 422 and the card directs the user to Sidebar preview; a same-named Host file is insufficient. The same configured desktop availability governs metadata and execution. Edits affect subsequent opens; deletion returns an error. No file-content copy or attachment is created. Plugin disposal cancels and awaits pending native-open requests.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the deliverables surface is not enough. They move from the card to the Host recorder, the turn-tail hole, and the decisions behind the vocabulary.

- [workspace-changes](../../fs/workspace-changes/README.md) — the Host plugin that records the summary the card renders.
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

One fixed prompt paragraph whenever this package is loaded. The [present tool](../../fs/tool-present/README.md#model-experience) owns the delivery schema and result text.

#### KV Cache effect

The section is static at first-party order 9000 for the lifetime of the package mount, so it remains in the reusable prompt prefix and does not change across Turns.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the current deliverables vocabulary. They are current package constraints, not a general file-linking comparison or a task backlog.

- **Mention matching is exact path or unique basename only** — a suffix mention stays inert; widening the matcher is deferred until a real closing-message shape needs it.
- **Terminal-created files require explicit delivery** — the card lists them once git records the change, but delivery cards and clickable references still require `present`.
- **Declarations do not preserve file contents** — reopening or transferring a Session requires source files accessible through the viewed Session’s filesystem. Missing files, directories, and final symbolic links return 404.
- **Folder opening needs a Host desktop** — without one the card header is inert and rows fall back to the right Sidebar's text preview, which shows files only.
- **Files outside the workspace open by absolute path only** — the recorded path is the Host path at recording time; a moved workspace or a different viewing Session cannot relocate it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Prompt, slot, dictionary, file-action route, and optional service registrations are effect-owned; the Session log owns declarations and the filesystem owns file contents.
