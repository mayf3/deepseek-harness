---
description: "Document previews in the right Sidebar: shared file loading and controls, selectable Markdown, code, PDF and HTML renderers, and plain-text fallback."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-sidebar-documentpreview

English | [中文](README.zh.md)

## Summary

Preview readable files in the right Sidebar and choose among registered renderers without opening another tab. Markdown and code receive accumulated text pages; PDF and HTML receive complete bytes; unknown file extensions use plain text. The tab owns loading, file status, renderer selection, wrap, and reload, while document bodies register through the same metadata registry and child slot. The Sidebar tab kind is `text`.

## Table of Contents

- [What it registers](#what-it-registers)
- [Addresses](#addresses)
- [How it reads](#how-it-reads)
- [Navigation](#navigation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="what-it-registers"></a>
## What it registers

- **The type** — `ctx.sidebarRightTabs.register(...)` with id `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` (this implementation's identity in the tab system, and the key its body registers under), kind `text`, pattern `dsh-resource://file/**`, band `fallback`. `canOpen` accepts only Session addresses, whose paths may be relative or absolute; bare `absolute` addresses are not claimed. A type registered at the `extension` or `builtin` band for a narrower pattern (say `*.png`) takes those addresses; other supported files land here. The whole address is the content identity, so two files with one name in different directories, or one path under two sessions, are two tabs; the decoded basename is the tab title.
- **The body** — the keyed `sidebar.right.pane.tab` seat under the type's id. Its fixed header shows the Host's absolute path when available, otherwise the requested path, and a dropdown for matching renderers plus plain text. A wrap toggle appears only when the selected renderer declares `wrap: true`; the per-tab preference starts on. Reload stays in this header, not the Sidebar's tab strip. The shared body below owns document scrolling.
- **Shared loading and view state**, session-scoped and bucketed by tab id. The store holds accumulated pages or complete bytes, read and observed versions, loading/failure state, renderer choice, scroll offset, wrap, and the answered navigation revision. The ordinary inject face calls Remote readers and writes through declared store actions. Reloads and loading-mode changes retire older requests; the tab's abort signal forgets its state.

Document implementations register metadata with `ctx.documentPreviews.register({ id, extensions, priority, title, loading, wrap? })` and a body under the same `id` in the keyed, Session-scoped `sidebar.right.tab.document` child slot. Own both registrations with effects and wait for the child slot through `ctx.slots.inject`. Bodies receive `resourceAddress`, prepared `content`, `wrap`, and the standard `useTabInfo`/`useResource` hooks; they do not receive a custom resource loader. Metadata declares `loading: 'text-pages'` or `'bytes-complete'`. The registry retains all matching alternatives: `extension` (the default) ranks above `builtin`, then longer suffixes rank first, then registration order. The dropdown preserves a selected implementation while it remains available; removing it selects the next candidate. Builtin bodies use these same registrations.

### Configuration

HTML limits are fields on this package's root Client `Config`, configurable on its existing plugin row:

| Field | Default | Meaning |
|---|---|---|
| `htmlMaxAssetBytes` | `4194304` (4 MiB) | Maximum decoded bytes in one directly referenced local script or stylesheet |
| `htmlMaxTotalBytes` | `33554432` (32 MiB) | Maximum decoded bytes in the root HTML and its unique packed assets together |
| `htmlMaxAssets` | `64` | Maximum distinct local script and stylesheet references packed for one HTML document |

<a id="addresses"></a>
## Addresses

A tab uses the Session address built by `fileAddressFor`, carrying a relative or absolute path. `hostFileOf(address)` takes the Session only from that address, with no external Session argument; neither current nor Tab Session is borrowed. The Host resolves file and related paths through the Session filesystem, whose backend controls read authority. Metadata for the same complete address is shared by every UI, including Global components. The [Workspace Files README](../../api/workspace-files/README.md) owns these rules; renderer selection does not change the navigation address.

<a id="how-it-reads"></a>
## How it reads

The body reads its record, navigation and lifetime through `useTabInfo().tab`. `useResource<'file'>(tab.contentId)` supplies metadata; ordinary inject callbacks supply content reads:

- The resource snapshot contains only `status`, `value`, and `failure`; `value` is `WorkspaceFileStat` metadata. Content reads do not wait for the first metadata frame once the provider is available. Observation failures take precedence over Preview's change notice; neither automatically replaces loaded content.
- **Text pages** — plain text, Markdown, and code read through an inject callback to `remote.workspaceFiles.read(sessionId, path, { offset }, signal)`. The first mount reads page one; scrolling to the body end or **Load more** requests the next page until `eof`. The owner delivers the accumulated prefix as `{ kind: 'text', text, pages, eof }`, including source offsets and line counts. Markdown and code render that prefix incrementally; they do not render each page as a separate document. A newer-version page past page one restarts from the beginning rather than mixing versions. Failures retain loaded content and offer a retry.
- **Complete bytes** — PDF and HTML use an inject callback to `remote.workspaceFiles.readAll(sessionId, path, signal)`. `rpc.ts` decodes the wire base64 into `data: Uint8Array<ArrayBuffer>` for `{ kind: 'bytes', data }`. The Host's `maxFileBytes` cap rejects oversized files rather than truncating them. PDF copies retained bytes before worker transfer, keeping the Preview buffer usable. Bytes stay in transient view state, never persisted layouts or Session JSONL. Loading-mode changes retire previous results.
- **Reload** — only the current Preview tab rereads through its Remote callbacks, preserving its scroll preference and retiring older requests. Its change notice compares the read version and the observation captured at read start with later `resource.value.version`; an already observed version does not become a new change after refresh. Reads neither refresh shared metadata nor clear another tab's notice.

HTML runs in a Blob iframe with exactly `sandbox="allow-scripts"`, without `allow-same-origin`; scripts cannot access the parent application's origin or file reader. The renderer loads directly declared relative `.js` classic scripts and `.css` stylesheets through its ordinary inject callback to `remote.workspaceFiles.readRelated`, under the configured limits. Host code resolves the related path; `rpc.ts` decodes the returned bytes. Inside the renderer, base64 is used only to embed the iframe bootstrap payload in script text. A `<base href>` leaves dependency resolution to the browser, as do HTTPS resources. Local module imports, CSS `url()`/`@import`, and dynamic `fetch` do not use Host file access. Read failures, invalid UTF-8, or exceeded limits fail the preview rather than publishing a partial asset package. Replacing or unmounting the document releases its Blob URL.

Shared copy comes from `sidebarDocumentPreview`; each builtin renderer owns its localized labels.

Initial reads, additional pages, and HTML/PDF preparation share a loading indicator that respects reduced-motion preferences. Loaded pages stay visible while another page loads. PDF pages form one vertical, width-fitted sequence and render lazily near the viewport. Code previews show source line numbers by default without including them in copied text; plain text uses the same font size and line height as code.

<a id="navigation"></a>
## Navigation

`ctx.sidebarRight.openResource(address, { params: { line } })` carries a 1-based source line through the `file` parameters. In `text-pages` mode, the owner loads sequential pages until that line or EOF, then locates a source-line anchor if the renderer supplies one; plain text supplies these anchors. Byte-mode renderers do not consume source-line navigation. Each navigation revision is answered once; remounting restores the shared scroll offset. Opening the same file without `revealIfOpened: false` focuses its existing tab and delivers a new revision.

<a id="model-experience"></a>
## Model Experience

None, as the preview is a browser-only viewer that registers no tool, prompt section, or session event.

#### KV Cache effect

No direct effect; what the user reads here never enters a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>
- **Preview, not editing.** The viewers provide no file editing or shared search interface; a directory address fails with `not-regular-file`. Unknown extensions use the plain-text reader and remain subject to its UTF-8/NUL checks.
- **Sequential text and bounded complete files.** Deep source lines require the preceding pages; PDF and HTML require a complete result within the Host's `maxFileBytes` cap.
- **Finite local HTML dependencies.** Only direct classic `.js` and stylesheet `.css` references are packed. Browser-resolved resources retain browser origin and network restrictions; no runtime file-read bridge is exposed to the iframe.
- **Package-local wrap glyph.** `IconWrapOutline16` lives in `src/client/icons.tsx` until the shared icon set carries one; the props contract already matches.
- **Scroll writes are unthrottled.** Every scroll event records its offset in the store; the line blocks are memoized so the resulting re-render hands React the same elements back.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Renderer metadata, document loading, and view state belong to the local registry and declared Slot stores, with no independent runtime source to compare against; registration disposal and tab lifetimes are covered by behavior tests.
