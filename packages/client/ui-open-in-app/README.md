---
description: "Web \"Open In...\" controls: the Session-header split button launching the remembered application on the workspace directory, and the document preview's default-application open and reveal controls for one file."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-open-in-app

English | [中文](README.zh.md)

## Summary

This package provides the browser surface of the open-in-app feature. A Session-header split button opens the current session's workspace directory (the summary's `cwd`) in the remembered application, and its chevron lists every catalog application the host probed as installed; availability, icons, and launches come from the host routes of [`dsh-host-open-in-app`](../../host/open-in-app/README.md), so mount the two packages together. In the right Sidebar's document preview, an "Open" split button and an empty-state button open the previewed file in its default application or show its location, through the Session Remote. A host without the capability renders none of these controls.

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

Mount this plugin in the Web composition beside [`dsh-host-open-in-app`](../../host/open-in-app/README.md); the pair composes the whole feature in two cordis.yml rows and this row takes no config. The Session header grows an "Open In..." split button whenever the host probed at least one installed catalog application and the session has a known workspace directory. The document preview of [`ui-sidebar-documentpreview`](../ui-sidebar-documentpreview/README.md) grows its file controls whenever the Host reports a desktop through the Session Remote's `session.canOpenWorkspacePath`; removing this row removes every control at once.

### What to expect

The main button shows the remembered application's icon — the real application icon wherever the host extracts one (macOS bundle icons, Windows executable icons, Linux theme icons), a generic glyph where it serves none — and a design-system tooltip ("Open locally"); clicking launches immediately. The chevron opens a dense menu of the installed applications with the remembered one marked by a filled row. Availability is read once per page from the host; the last chosen application persists in the browser (`dsh.open-in-app.choice`), and a choice that is no longer installed falls back to the first available entry. A launch that finishes quickly leaves the button untouched — the dimmed busy treatment appears only after 250 ms in flight — and a failed launch shows the error tooltip and a red outline for two seconds. All copy lives in the bilingual `open-in-app` locale namespace; an application id the dictionaries cannot name is not offered.

In the document preview, the header's "Open ▾" split button opens the previewed file in the Host's default application from its main button, and its menu offers that action and "Show file location" (the file manager's reveal). A file the preview cannot render, whether an unsupported suffix such as video or an archive or a file the reader rejected as non-text or oversized, shows an "Open in default app" button in its empty state where Retry would otherwise stand. Both controls hand the Host the absolute path the file's metadata reports, appear only after the Host answered that a desktop is available, disable only while their own gesture settles, and announce a failed gesture once through a transient toast ("Could not open. Try again." or "Could not show the file location. Try again."); nothing stays on the control afterwards.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin registers the split button on `conversation.session.header.utilities` through the standard slot/inject currency and registers the `open-in-app` dictionaries as one effect. A page-lifetime controller ([`src/client/controller.ts`](src/client/controller.ts)) owns the once-per-page availability read, the persisted choice snapshot store, and the launch POST; the component receives both stores through the inject `hooks` compartment, so every Session header shares one truth. Route paths and wire payload types are inlined from the host package's browser-safe `@deepseek-ai/dsh-host-open-in-app/shared` subpath. In-flight launches are guarded by a ref — repeat clicks and menu picks during a launch are ignored whole (a pick would otherwise persist a choice the gesture never opened) — and the busy/error dress is timer-driven around the `launch` promise.

The file controls register on the document preview's `sidebar.right.tab.document.actions` and `sidebar.right.tab.document.unpreviewable` child slots, whose owner props carry the file’s absolute execution-environment path. A second page-lifetime controller ([`src/client/open-path.ts`](src/client/open-path.ts)) reads the Session Remote's `session.canOpenWorkspacePath` once per page into a desktop snapshot store both controls share, and runs each gesture through `session.openWorkspacePath` with the path and, for reveal, `action: 'reveal'`; a refused or rejected call resolves as the failure kind the control announces. The controls share one gesture hook that owns the pending flag and the toast, so a gesture from one control never restyles the other. The node half is an empty `apply` that keeps the plugin on the host roster.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-host-open-in-app](../../host/open-in-app/README.md) — the host routes serving availability, icons, and launches, and the catalog behind them.
- [dsh-session-log-export](../../session-query/session-log-export/README.md) — the sibling Session-header action.
- [ui-sidebar-documentpreview](../ui-sidebar-documentpreview/README.md) — the document preview declaring the header and empty-state child slots the file controls occupy.
- [ui-deliverables](../ui-deliverables/README.md) — the delivery cards, which still open declared files through their own routes.
- [Web client architecture](../../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.md) — how browser plugin rows load and register slots.

-----

<a id="model-experience"></a>
## Model Experience

None, as the split button is browser chrome; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

The Host verifies the path through the composed filesystem before opening or revealing it. Paths without a matching Host mapping fail without launching a native application. Default opening follows the file-type association, including HTML and SVG.

<a id="known-limitations-and-deferred-work"></a>

- **The dictionaries gate the menu.** A host catalog extension without a matching `app.<id>` entry in both dictionaries stays invisible instead of showing a raw id; extending the catalog means extending [`dsh-host-open-in-app`](../../host/open-in-app/README.md) and this package's locales together.
- **Availability is read once per page.** An application installed while the page is open appears after a reload (and, host-side, after a host restart); the desktop answer behind the file controls is read once per page as well.
- **One reveal label for every platform.** The Session Remote reports whether a desktop exists, not which file manager it runs, so the menu says "Show file location" rather than naming Finder or File Explorer as the delivery cards do.
- **The delivery cards keep their own opener.** [`ui-deliverables`](../ui-deliverables/README.md) still opens declared files through its own Session-and-event routes; folding those cards onto the file controls here is deferred to the [Agent Note](../../../.agents/notes/implemented/feature/2026-09-16-open-in-default-app-for-sidebar-files.md).

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The feature-level decisions, including the split into the host package and this surface, are recorded in the [promotion Agent Note](../../../.agents/notes/implemented/feature/2026-08-25-promote-open-anywhere-plugin.md); the document preview's file controls are recorded in the [default-application Agent Note](../../../.agents/notes/implemented/feature/2026-09-16-open-in-default-app-for-sidebar-files.md).

</details>

**Runtime invariant:** No companion is published. The plugin registers one dictionary effect and three slot entries whose disposal the HMR-safety spec proves; application availability, the choice, and the desktop answer live in the controllers' snapshot stores with no second copy to diverge.
