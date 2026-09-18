# Agent Note: On-demand watching and automatic refresh for Sidebar previews and file trees

Status: proposed

English | [中文](2026-09-17-sidebar-file-and-directory-auto-refresh.zh.md)

## Problem

The Sidebar's Document Preview and Files panels need to reflect current disk state. Changes come from Harness file tools, shell commands, user editors, and other processes; observing only Harness file operations is insufficient.

Both read paths exist, but neither has a complete automatic-refresh path.

| Object | Existing behavior | Gap |
|---|---|---|
| File Resource | `ResourceProvider.open()` supplies initial metadata and later changes; `ResourceRegistry` owns subscriptions and retention; components read through `useResource` | File changes do not come from an OS watcher |
| Document Preview | `TextPreview` compares Resource and content versions and provides reload for three loading modes | A change only prompts the user to reload |
| Workspace file events | `WorkspaceFiles.changes()` forwards the current Session's `fs/observed`; the Client filters by file | The Host does not know which paths are followed; external editors and shell writes produce no such events |
| Files panel | `filesFace` lists directories; `createFilesStore` retains loaded levels and expansion state | Creation, deletion, and renaming require manual refresh; reopening an expanded directory can show old cached entries |

`Resource` holds file metadata, not preview contents. Document Preview or its selected renderer reads the contents. Metadata updates and content reloads therefore remain separate responsibilities: the generic Resource acquires no content cache, and renderers do not directly manage filesystem watchers.

## Proposal

Connect on-demand observation through the existing FS, Workspace file stream, Resource, and Sidebar components. Files and directories share OS watching and the existing Remote stream transport, but consume them differently.

- Document Preview follows the current file. Its Resource publishes new metadata, and the preview invokes its existing reload. The HTML root and referenced CSS/JS files join one `ResourceGroup`; any member change invalidates the whole HTML preview.
- Files manages reads and watchers through a directory-node tree. Each open node loads and watches only its direct entries. The Client loads and subscribes to exactly the subtree levels it opens, without traversing unopened descendants.
- Collapsing a directory releases that directory's watch and those of its hidden descendants. Reopening subscribes and reads again; the old cache is not treated as current.
- Watches carry only metadata or invalidation. Contents still use the existing file readers; directory contents still use `list()`.
- Local Chokidar watches use OS events, without polling the whole Workspace or recursively scanning all descendants by default.
- Both panels retain manual refresh and automatic-refresh functionality, but temporarily hide the automatic-refresh icon button. State and toggle logic remain; new Tabs default to enabled. Hiding the control does not stop observation or automatic refresh.

This change only connects notifications to existing reload/list operations; it does not add retention of previous preview content after a failed reload. The following sections distinguish existing types from new objects and describe responsibilities, data flow, and acceptance scope. An acceptance item is not complete until it passes.

## Class and file changes

### FS and Host

| Class or type | File | Intended change |
|---|---|---|
| `FileSystem` | [fs/src/index.ts](../../../../packages/fs/fs/src/index.ts) | Declare abstract single-target `watch(target, changed, signal)`: a file observes itself; a directory observes its direct entries. Resolve with an async close function once ready. Unsupported providers explicitly throw, without a new FS error code |
| `FsTarget` | [fs/src/types.ts](../../../../packages/fs/fs/src/types.ts) | Reuse the existing target type, without another FS watch-event system or upper-layer parsing of `targetKey` |
| `LocalFileSystem` | [fs-local/src/index.ts](../../../../packages/fs/fs-local/src/index.ts) | Adapt Chokidar, normalize local events into FS invalidation, and await watcher closure; declare the dependency in `fs-local` |
| `SandboxedFileSystem` | [fs-sandbox/src/index.ts](../../../../packages/fs/fs-sandbox/src/index.ts) | Inherit local read-only observation without duplicating the watcher; retain its write and edit policy checks |
| `SshFileSystem` | [fs-ssh/src/index.ts](../../../../packages/ssh/fs-ssh/src/index.ts) | `watch()` explicitly throws an ordinary exception; the Host converts it to a `workspace-file/watch-unsupported` `RemoteError`, without importing or checking an `FsError` runtime class across packages or passing remote `processPath()` values to local Chokidar |
| `WorkspaceFiles` | [workspace-files/src/index.ts](../../../../packages/api/workspace-files/src/index.ts) | Replace `changes(scope, signal)` with an explicit target request. File requests retain Session file resolution and access rules; directory requests retain `list()`'s Workspace restriction |
| `WorkspaceChangeFeed` | [workspace-files/src/changes.ts](../../../../packages/api/workspace-files/src/changes.ts) | Establish the target watch in the existing follow path and emit readiness and changes. Retain the queue and operation-observation input; filter by target before emission without rewriting dispatch |
| `ChangeFollower` | [workspace-files/src/changes.ts](../../../../packages/api/workspace-files/src/changes.ts) | Receive existing operation observations and new OS watch notifications; handle watch errors and completed closure |
| `WorkspaceWatchRequest`, `WorkspaceFileWatchFrame` | [workspace-files/src/types.ts](../../../../packages/api/workspace-files/src/types.ts) | Add target path and file/directory intent; reuse `ready`/`change` frames, interpreted by each consumer's request, without a separate directory frame format |

### Client and Sidebar

| Class, function, or type | File | Intended change |
|---|---|---|
| `ChangeFeed`, `SessionFeed`, `Follower` | [workspace-files/src/client/change-feed.ts](../../../../packages/api/workspace-files/src/client/change-feed.ts) | Key streams by Session and target path; reuse readiness, path binding, cancellation, and reconnect logic without reorganizing classes just to rename them |
| `createFileResourceProvider` | [workspace-files/src/client/provider.ts](../../../../packages/api/workspace-files/src/client/provider.ts) | Pass the address's Session and path to the target stream; publish complete metadata initially and after notifications, rather than replacing `version` while retaining stale `bytes` |
| `ResourceRegistry`, `ResourceProvider`, `UseResource` | [Resource definitions](../../../../packages/client/resources/src/client/contract.ts), [ResourceRegistry](../../../../packages/client/resources/src/client/resources.ts) | Keep existing streaming, retention counts, and subscriptions; add neither a second `onChange` nor a generic content-reload API |
| `TextPreview` | [TextPreview.tsx](../../../../packages/client/ui-sidebar-documentpreview/src/client/TextPreview.tsx) | Invoke existing reload when a Resource or group changes and automatic refresh is enabled; retain errors and manual refresh, with the separate automatic-refresh button temporarily hidden |
| `textFace`, `TabReads`, `createTextStore` | [Preview face](../../../../packages/client/ui-sidebar-documentpreview/src/client/face.ts), [Preview store](../../../../packages/client/ui-sidebar-documentpreview/src/client/store.ts) | Own one group per Tab; add default-enabled `autoRefresh` and pending-refresh flag `resourcesDirty`; reuse content-read generations and `loadRevision` |
| New package-private `ResourceGroup` | [resource-group.ts](../../../../packages/client/ui-sidebar-documentpreview/src/client/document/resource-group.ts) | Observe members through existing `resources.source(address)`; `add` joins a resource, `set` reconciles full membership, and `close` releases all members without changing the generic Resource service |
| `DocumentBodyOwner`, `HtmlBody`, `createReadHtmlRelative` | [Renderer inputs](../../../../packages/client/ui-sidebar-documentpreview/src/client/document/contract.ts), [HTML body](../../../../packages/client/ui-sidebar-documentpreview/src/client/html/HtmlBody.tsx), [Related-file reader](../../../../packages/client/ui-sidebar-documentpreview/src/client/html/read-relative.ts) | Renderers declare read members through `addResource` and publish the current dependency list through `setResources`; HTML adds CSS/JS resources before reading and releases unreferenced members after parsing |
| Document renderers | [DocumentContent](../../../../packages/client/ui-sidebar-documentpreview/src/client/document/contract.ts) and renderer directories in the same package | Do not watch directly; keep consuming text, bytes, or renderer revisions. Check cancellation of previous work, release of old objects, and retention of existing view preferences during refresh |
| `filesFace`, `FilesInjected` | [Files face](../../../../packages/client/ui-sidebar-files/src/client/face.ts) | Remain the existing business entry point, directly owning each Tab's root node; bind directory reads and change streams and forward expand, collapse, refresh, and automatic-refresh operations without a new `FilesController` |
| New package-private `DirectoryNode` | [directory-node.ts](../../../../packages/client/ui-sidebar-files/src/client/directory-node.ts) | Represent one open directory, owning its stream, read state, and open children; handle local refresh, expansion, recursive closure, and propagation of automatic-refresh state |
| `createFilesStore`, `FilesTabState`, `LevelState` | [Files store](../../../../packages/client/ui-sidebar-files/src/client/store.ts) | Retain expansion, scrolling, and displayed directory data; distinguish initial loading from refresh over existing content to avoid unmounting subtrees on every background read; hold no watcher or AbortController |
| `FilesBody`, `Level`, `Entry` | [FilesBody.tsx](../../../../packages/client/ui-sidebar-files/src/client/FilesBody.tsx) | Delegate expansion, collapse, refresh, and panel unmount to injected callbacks; render node results without scanning the entire tree into a watch set, using existing framework hooks and store reads |
| Files registration | [Files client/index.ts](../../../../packages/client/ui-sidebar-files/src/client/index.ts) | Add a directory-change callback to the existing `filesFace`; keep async effects in injection, without importing another feature plugin's runtime exports |

## Watch requests and notifications

### One stream per explicit target

The old `changes(sessionId)` cannot tell the Host which file or directory needs an OS watcher. Directory support calls for two explicit request variants, rather than inferring intent from the current `stat`.

```text
changes(sessionId, { kind: 'file', path }, signal)
changes(sessionId, { kind: 'directory', path }, signal)
```

The Host method still receives resolved Session context through `WorkspaceFileScope`. The Client supplies a Session id; it cannot forge the Host's working directory or permissions.

`kind` expresses watch intent and does not change when the target temporarily disappears. A deleted file remains a watched file location; a deleted directory subscription does not become a file subscription.

| Notification | Contents | Consumer action |
|---|---|---|
| Ready | This generation's target watch is established | Perform initial or reconnect `stat()`/`list()` and consume changes queued during the read |
| File present or updated | Existing path and version notification; Client stats again | Update Resource path, version, and size from the complete result; reread contents when automatic refresh is enabled |
| File absent | Target path and absence state | Resource reports unavailability; preview retains loaded content and shows the error |
| Directory invalidated | `change` frame in that directory's target stream | Call only that directory's `list()` again, without deduplicating by directory version or refreshing the entire tree |
| Watch failure | Initialization failure reports `workspace-file/watch-unsupported`; runtime errors end the watch | The Client handles failure where it consumes the watch; ordinary reads and manual refresh remain available, without reporting file deletion |

Notifications need neither file contents, complete directory listings, nor per-change patches. Paths identify filenames; current stat supplies size. Modification time used only for freshness remains part of the backend version token, without UI token parsing or another timestamp comparison.

Resource path, version, and size come from the same stat. Keep the existing small notification followed by Client stat instead of expanding the event protocol to save one request. Directory invalidation cannot depend only on directory mtime: a direct child's size or type can change `list()` output, so relevant child events invalidate that level.

### OS watching and access scope

- `FileSystem.watch()` accepts a target resolved by its provider; the FS provider owns the meaning of local or remote paths.
- File watching retains file-read access rules. Existing previews may read some paths outside the Workspace through the selected FS; directory-tree containment must not be imposed on those files.
- Directory watching retains `list()`'s Workspace scope and path checks, without widening browsing authority.
- File watching covers in-place writes, replacement by a temporary file, deletion, and recreation at the same path. Chokidar may internally observe the necessary parent directory, but the public watch still targets the specified file.
- A directory watch observes itself and direct entries, without recursively opening unexpanded children. Creation, deletion, renaming, type changes, and visible metadata changes of direct entries invalidate that level.
- Local watching uses OS events. Deployment controls such as write-stability time or event-coalescing windows, if needed, belong in their owner's configuration rather than scattered component constants.
- OS watching drives UI refresh only. It does not fabricate an agent's authoritative `fs/observed` read observation or change the observed-version policy for editing.

## Complete file-preview data flow

```text
Files.openResource / file.link
  → Sidebar.openTab
  → TabDomain → Resource.pin
  → ResourceRegistry → createFileResourceProvider.open
  → changes(sessionId, { kind: 'file', path })
  → WorkspaceFiles → FsTarget
  → WorkspaceChangeFeed → FileSystem.watch
  → LocalFileSystem → Chokidar
  → ready → Client.stat → ResourceSnapshot

Editor / Shell / file tool → disk
  → Chokidar → LocalFileSystem
  → WorkspaceChangeFeed → FileSystem.stat
  → Remote.change
  → Client.stat → ResourceSnapshot
  → TextPreview.useResource
  → reloadPages / reloadAll / prepareRenderer
  → DocumentContent / renderer revision
  → renderer
```

Existing preview content reads may run in parallel with metadata initialization; watching does not require reordering all loading logic. The preview retains its existing content-version comparison. ResourceGroup only forwards member metadata changes, without separate pre-read and post-read version reconciliation.

| Loading mode | Existing refresh entry | Result |
|---|---|---|
| `text-pages` | `reloadPages()` | Retire the old content generation and reread text pages without mixing versions |
| `bytes-complete` | `reloadAll()` | Reread complete bytes for PDF, HTML, image, and other byte consumers |
| `renderer` | `prepareRenderer(..., reload = true)` | Increment `loadRevision`; the renderer cancels its previous load and requests again, as for Office conversion |

Ordinary renderers need neither `watch()` nor a new reload interface. Changes to existing `DocumentContent` text, bytes, and revisions already drive reloading.

## HTML ResourceGroup

An HTML preview's group contains the HTML root and CSS/JS files actually read by the existing packer. Every member is an ordinary file Resource, with no separate dependency watcher or file type. The group is package-private and reuses Resource subscriptions and retention counts.

```text
index.html Resource ─┐
theme.css Resource ──┼→ ResourceGroup → resourcesDirty → autoRefresh → HTML reload
page.js Resource ───┘
```

- `addResource(address)` joins a dependency before reading. Existing members do not resubscribe, and no content-read version is passed or retained.
- `setResources(addresses)` commits the parsed dependency list. The preview owner always retains the root and releases other members absent from the new list.
- CSS/JS references use the existing HTML relative-file reader and the HTML's Session, without guessing local paths from the browser page URL.
- A CSS or JS change reloads the complete HTML and creates new iframe content even when the HTML source itself is unchanged.
- Missing dependencies and recovery also change members. Parsing failures retain already discovered dependencies so recovery can trigger another load.
- A new member's initial metadata also invalidates the preview, accepting a possible extra refresh during initial dependency loading. Repeated metadata versions do not notify again, without first-read version reconciliation.
- Group changes set only `resourcesDirty` to `true`. Refresh clears it; another change during reading sets it again. No notification counter or separate read generation is added.
- Closing the preview Tab releases the whole group. Disabling automatic refresh only stops automatic rereads; the group continues observing and recording stale state.

This version covers direct stylesheet links and classic JS scripts already supported by the interactive HTML packer. It does not add CSS `@import`, ES module graph, or runtime network dependency discovery. Static safe preview reads no related files and therefore observes only the root.

## Automatic-refresh controls

Document Preview and Files each retain their existing reload button. The separate automatic-refresh icon control is temporarily hidden; its state, toggle logic, copy, and styles remain. New Tabs still default to `autoRefresh: true`. Hiding the control neither removes the feature nor makes it impossible to disable.

| State or action | Behavior |
|---|---|
| Automatic refresh enabled | The control is highlighted, uses the existing pause icon, and offers “Disable auto refresh”; changes refresh the corresponding preview or directory node |
| Disable | The control shows the play icon and offers “Enable auto refresh”; observation continues without automatically replacing displayed content |
| Reenable | Refresh once immediately if changes occurred while paused, then resume automatic refresh |
| Original reload button | Read again regardless of automatic-refresh state, without changing that state |
| Expand a new directory while paused | The new directory still loads initially and subscribes; the switch controls only subsequent automatic rereads |

Pause and play use existing icons; manual reload retains its circular arrow. No new icon system is added. The button exposes state through `aria-pressed`, with its name and tooltip in the existing locale dictionaries.

## Complete Files-panel data flow

```text
Files.open
  → FilesBody → Session.cwd + Tab
  → filesFace.start → DirectoryNode.open
  → changes(sessionId, { kind: 'directory', path })
  → Host.watch(depth: 0) → ready
  → DirectoryNode → list(sessionId, path)
  → createFilesStore.levels[path]
  → Level / Entry

Entry.expand
  → filesFace.toggle
  → DirectoryNode.expand → child.open
  → child.watch → ready → child.list
  → createFilesStore.expanded + levels[path]

Process → create / remove / rename
  → Host.change(directory)
  → DirectoryNode.refresh → list(path)
  → createFilesStore.levels[path]
  → DirectoryNode.children ↔ list.entries
  → DirectoryNode.collapse → child.close
```

File previews and the directory tree are independent consumers. A preview can refresh without an open Files panel; Files can update entries without any file preview. Neither a Resource for the whole tree nor a new directory Resource protocol is needed.

The directory panel obtains invalidations and listings through injected Remote callbacks and writes displayed values through its own store. Components retain their existing read interfaces and do not directly hold Chokidar, Remote iterators, or low-level observation objects.

## Directory-node tree and lifecycle

The Files runtime is itself an on-demand directory tree. It does not first construct the whole Workspace tree or separately derive a flat watcher set. Existing `filesFace` owns each Tab's root; `DirectoryNode` owns reads, observation, and release recursively, without another controller class.

| Node responsibility | Behavior |
|---|---|
| Directory identity | Hold this directory's path and Session/Tab ownership; its listing contains only direct entries |
| Directory watch | One open node holds one target stream; notifications invalidate only this node's listing |
| Directory read | Retain the active list generation and pending-reread state; publish results through store actions |
| Open children | Hold child `DirectoryNode` objects by direct-child path; unexpanded directories remain listing entries without active nodes |
| Expand | A directory-row action creates or reuses its child, which subscribes and reads; restoration opens only directories still present in the listing |
| Collapse | Remove and close the active child; recursively close its descendants and release its watch and requests |
| Listing update | Retain open children still present; close deleted, renamed, or file-replaced branches without reopening every node |
| Close tree | Closing the root recursively releases the active tree, without traversing another global watcher registry |

`createFilesStore.expanded` may retain user expansion preferences, but is not another watcher registry. Closing a parent cannot retain active descendant nodes merely because their preferences remain. Reopening first reads the parent, then progressively restores still-present children. If the user collapses a descendant during that read, remove its pending restoration too, so an older request cannot reopen it.

```text
workspace/                  watch
├── src/          open      watch
│   ├── components/ open    watch
│   └── internal/ closed    -
└── assets/       closed    -

collapse(src/):
workspace/                  watch
├── src/                    close(src/, components/)
└── assets/                 -
```

The parent's watch still detects deletion, renaming, or replacement of a collapsed child, but not changes deep inside it. Listing again on expansion discovers changes made while it was not watched.

| User action or lifecycle event | File preview | Files panel |
|---|---|---|
| First open | Subscribe to the file Resource and read contents | Open the root node, which subscribes and lists |
| Expand child | No effect | The parent opens the child; the child subscribes and reads direct entries, progressively restoring still-present descendants from preferences |
| Collapse child | Open file previews keep their watches | Release that directory and its hidden descendants; expansion preferences and displayed cache may remain |
| Switch Tab or unmount panel | The Tab pin retains file metadata; an unmounted body does not reread, and refreshes on return according to version and toggle state | Retain expanded nodes and watchers for the Tab lifetime; do not introduce another panel-visibility lifetime |
| Manual refresh | Reuse the current preview reload without rebuilding the Resource system | Recursively refresh open children from the root, without entering collapsed directories or rebuilding all watchers |
| Last holder closes | Resource abort ends the file stream; the Host awaits watcher closure | Tab closure ends every directory stream, cancels reads, and forgets Tab state |
| Connection recovers | Stat again after the new stream's ready frame, discovering changes even without event replay | List every still-watched directory after its new stream's ready frame |

Files watches follow Tab lifetimes. Collapse closes the corresponding subtree; Tab closure releases the root and its entire active tree. Temporarily hiding the panel does not rebuild nodes, keeping implementation within the existing entry point and directory objects. The store retains expansion preferences; nodes use them for progressive restoration only when reopened, without a second global expansion set.

`ResourceRegistry` continues sharing identical complete file Resource addresses. Parent-child ownership prevents duplicate active branches inside one Tab. This version adds no global watcher deduplication across Sessions, windows, or path aliases. Ordinary file rows do not each subscribe to file watches; only files opened as preview Resources acquire independent file observation.

## User flows

### Edit a previewed file

1. The user opens Markdown, code, an image, PDF, HTML, or Office file from Files.
2. The user saves it in an external editor or rewrites it through a shell command.
3. Automatic refresh is enabled by default, so Document Preview displays new content. Disabling it retains current content until manual reload or reenabling.
4. Renderer selection and wrapping preferences remain. Text scrolling uses existing restoration; shorter content limits the available position.
5. Exact position restoration for PDF, HTML, and images is not an additional promise. Existing renderer behavior remains, without a cross-format location system for automatic refresh.

### Browse changing directories

1. The user opens Files; the root lists and begins observation.
2. The user expands `src` and `src/components`; both start their own watchers.
3. An external tool creates a file in `src/components`; only that level refreshes, without collapsing or reloading other directories.
4. The user collapses `src`; its own watch and the `components` watch close, while the root remains watched.
5. External changes continue while collapsed. Reopening `src` rereads it and progressively restores valid descendant expansion, rather than remaining on old cached entries.

### Deletion, renaming, and failure

- Deleting a file retains existing preview content with an unavailable notice; recreating its original path resumes reading. Renaming means disappearance at the old path and appearance at a new one, without rewriting the preview address from inode identity.
- Deleting or renaming a directory refreshes its parent, removes the old row, and releases the old subtree. A new directory appears under its new name without transferring old-path expansion preferences.
- Automatic and manual refresh invoke the same existing reload, retaining its clearing, loading, and error presentation. No old-byte or old-iframe retention branch is added. Directory refresh retains the existing listing cache to avoid rebuilding active subtrees.
- When a backend cannot watch, the Host converts initialization failure into a `workspace-file/watch-unsupported` `RemoteError`. The Client ends observation while continuing ordinary reads and manual refresh, without polling. External SSH filesystem changes do not automatically update previews.

## Readiness, races, and refresh coalescing

Observation, reads, and presentation need a few explicit ordering rules, not disk transactions or an operation log.

- Establish the watch before sending ready, then obtain initial stat/list. Do not discard changes arriving during a read; reread when necessary to converge on current state.
- Events mean that a target may have changed, not exact replay of a user operation. Duplicate Chokidar events and consecutive writes may coalesce; files deduplicate versions, and directories coalesce pending refreshes.
- Each directory has at most one active list. Further invalidation during that request marks a pending reread, which runs after completion rather than building an arbitrary queue of refresh jobs.
- File refresh reuses read generations and renderer revisions. Consecutive notifications must not let old requests overwrite new content or endlessly reload an already handled version.
- Background directory refresh retains the displayed listing without a display-unused `refreshing` flag. Only a directory without displayable entries enters `loading`, avoiding subtree flicker and repeated watcher reconstruction.
- After collapse, deletion, or Tab closure, late cancelled reads cannot recreate state or restore watchers. Stream release awaits actual Host watcher closure.
- Temporary disappearance must not permanently end observation. Ordinary file changes and watcher failures remain distinct; the same-path watch covers atomic saves and delete/recreate.
- Existing file reads are not transaction snapshots: writes can occur between stat and content reading. Later notifications trigger refresh; the proposal does not promise an atomic snapshot for every read.

## Alternatives considered

**Another Resource `onChange` and content reload.** Existing `open()`, `source()`, and `useResource` already express change, while the generic Resource does not own contents. Duplicate interfaces would make metadata, contents, and renderers each manage refresh state.

**Recursive watching of the whole Workspace.** Opening one file or root directory should not watch every deep directory. Watching the current file and expanded directories ties resource use to what the user has actually opened.

**Keep Session broadcasts and add path registration/unregistration.** The Host needs explicit targets, but not another path set maintained through additional commands. One target per stream directly reuses cancellation, reconnect, and ending semantics.

**Push contents or complete listings.** This mixes observation with reads and duplicates pagination, byte limits, formats, and entry caps. Small notifications followed by existing `read()`/`list()` calls are more direct.

**Apply directory-row additions and removals from Client events.** Filesystem events can coalesce or repeat, while listings own sorting, types, and entry limits. Relisting the affected level retains existing semantics without a directory-patch merge algorithm.

**Call Chokidar directly in the Workspace API.** The API does not own the execution world; SSH paths may exist only remotely. The actual FS provider must implement watching.

## Acceptance criteria

Implementation can proceed in the following order, retaining the same explicit-target observation model throughout.

1. FS definition and local provider: file and nonrecursive directory watches, readiness, errors, and async release; the sandboxed local provider inherits them.
2. Workspace Remote: target requests, file metadata frames, directory invalidation frames, Client stream consumption, and rereads after reconnect.
3. Document Preview: ResourceGroup, HTML CSS/JS membership, automatic-refresh control, and the three existing reload paths.
4. Files: the existing face with an on-demand `DirectoryNode` tree, automatic-refresh control, local refresh, recursive collapse release, and progressive rereads on reopening.
5. Update affected READMEs, JSDoc, generated Remote declarations, and user-output verification; leave Session event logs, persistence formats, and model input unchanged.

| Acceptance scenario | Expected result |
|---|---|
| External in-place writes, atomic replacement, shell writes | Open previews refresh without depending on `fs/observed` |
| Text, complete bytes, renderer-owned loading | All three modes refresh; old requests cannot overwrite new results |
| Only CSS/JS changes, with unchanged HTML root | The group reloads the complete HTML |
| HTML removes a dependency reference | Updating membership releases the unreferenced Resource |
| Disable automatic refresh, modify, then reload or reenable | Content remains while paused and catches up on manual action or reenabling; the controls remain independent |
| Root's direct entries are created, deleted, or renamed | The Files root level updates automatically |
| An expanded child changes | Refresh only its level while preserving other levels and expansion preferences |
| Unexpanded deep directories | No deep watcher or recursive traversal |
| Collapse a parent | Release its watch and hidden descendants; an independently open file preview keeps watching |
| Reopen, return to Files, or reconnect | Obtain current listings without depending on replay of missed events |
| Delete/recreate or replace a directory with a file | Update presentation and release invalid subtrees; recover when the target returns |
| Rapid writes, duplicate notifications, changes during reads | Converge on current state with finite rereads, without endless refresh |
| Close Tab, unload plugin, cancel initialization | Close all owned watches; late notifications and reads no longer write state |
| Unsupported providers or out-of-workspace directories | Report unavailable observation or access errors explicitly, without watching the wrong execution world or widening directory authority |

Verification includes controlled readiness/cancellation tests, real local-watch integration on temporary directories, and preview/tree flows through the real Web composition. Real-file tests wait for watch readiness before acting and finish on observable state, not fixed sleeps. User-visible refresh updates the corresponding keyless replay or owner-local expected output; no GIF is produced. This section states acceptance scope; executed results belong in the PR.

## Risks

- OS file events are not durable messages. Disconnects and process restarts may lose notifications, so every stream generation obtains current state after readiness.
- Open files and expanded directories increase watcher and stream counts. The first version controls this through on-demand lifetimes, without an advance cross-consumer deduplication service.
- Automatic refresh may interrupt reading, especially HTML interactions and Office conversion. View preferences and coalescing remain, but arbitrary embedded-document runtime state is not preserved.
- HTML CSS/JS members come from the existing parser. Deeper dependencies, image dependencies, and runtime loading are not additional parsing work in this change.
- SSH OS watching needs its own remote implementation strategy. This interface declares unsupported operation honestly, without local watchers or implicit polling masquerading as remote support.

## Relationship to existing Agent Notes

This proposal adds automatic refresh and OS watching without replacing the overall Resource, file-read authorization, or renderer ownership design. The following records retain independent value; this note references them without editing or archiving them.

- [Client Resource model](../../implemented/architecture/2026-09-05-client-resource-model.md): retain addresses, providers, subscriptions, and lifetimes; existing streams carry the new behavior.
- [Workspace file service](../../implemented/architecture/2026-09-05-workspace-files-service.md): retain read and listing responsibilities; revise Session-scoped observation streams and event sources.
- [Document preview operations](../../implemented/architecture/2026-09-08-document-preview-operations.md): retain content-loading ownership and all three modes; change manual confirmation after file updates.
- [Workspace file-read authority](../../implemented/architecture/2026-09-09-workspace-file-read-authority.md): retain distinct access scopes for file reading and directory browsing; target watches follow their respective rules.
- [Sidebar text preview and file tree](../../implemented/feature/2026-09-05-sidebar-text-preview-and-file-tree.md): retain per-Tab expansion, navigation, and scrolling; add automatic directory invalidation and watches for expanded nodes.
