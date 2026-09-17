---
description: "Session-authorized Office conversion returned as PDF bytes for Client previews."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-document-render-controller

English | [中文](README.zh.md)

## Summary

Open an Office file from a Session and receive its rendered PDF. Source file access follows the ordinary workspace-file policy, and conversion does not activate an Agent or append Session events.

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

The [Web bundle](../../bundle/web-app/README.md) mounts this controller as `document-render-controller` beside `workspaceFiles` and `documentRender`. The controller has no configuration. Its `documentRender.render` Remote accepts a Session identity, a DOC, DOCX, XLS, XLSX, PPT, or PPTX path, and `foreground` or `background` priority; the shared Session lookup derives the workspace root on the Host.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The controller probes ordinary read access with a one-byte `workspaceFiles.readBytes` call and confirms the source version through `workspaceFiles.stat`, then supplies a deferred `workspaceFiles.readAllBounded` callback to the renderer. The callback passes raw source bytes directly to conversion. Admission precedes source allocation; the callback checks metadata after reading to reject concurrent source changes. A bounded-read size failure also rechecks source identity, reporting `source-changed` when the current source identity differs. Cached responses repeat the read probe and metadata check. The result carries base64 PDF bytes, original absolute path/version, and renderer generation. The `generation()` Remote lets Clients invalidate PDFs after renderer replacement. Other source-read failures pass through; conversion failures expose a classified reason without engine diagnostics. Cancellation releases this reader’s interest; the renderer retains active capacity until actual work settles. Controller unload joins its outstanding requests. No runtime invariant companion is published because results are transient and have no independently persisted state.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Workspace files](../workspace-files/README.md) — read policy and Session lookup.
- [Rendering service](../../document/office-to-pdf/README.md) — conversion inputs and results.
- [Office viewer](../../client/ui-sidebar-documentpreview/README.md#office-preview) — binary Client caching.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package serves previews without model-facing tools, messages, or Session events.

#### KV Cache effect

None; preview operations do not construct or modify model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Complete source reads also obey `workspaceFiles.maxFileBytes`; increasing the renderer input limit alone does not increase the read allowance.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
