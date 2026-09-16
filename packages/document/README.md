---
description: "Package map for Host Office conversion and reusable PDF results."
kind: "package-group"
---

# document/ — Office rendering

English | [中文](README.zh.md)

## Summary

Convert authorized Office files to reusable PDFs on the Host. The rendering family provides a shared conversion operation and a LibreOffice kit provider. macOS and Windows use their matching native engine; Linux uses Node WASM.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Each package owns its configuration and lifetime rules; the subsystem reference describes their shared rendering operation.

| Package | Role | ctx key |
|---|---|---|
| [document-render](document-render/README.md) | Authorized Office bytes to complete PDF results | `ctx.documentRender` |
| [document-render-libreoffice](document-render-libreoffice/README.md) | Host kit provider with cancellable concurrency and private scratch files | `ctx.documentRender` |

-----

<a id="related-documentation"></a>
## Related documentation

Consumers own source authorization and presentation.

- [Document rendering](../../docs/subsystems/document-render.md) — shared operation and generated service reference.
- [Independent kit ownership](../../.agents/notes/implemented/architecture/2026-09-14-independent-libreoffice-kit.md) — engine distribution and application integration.
- [Workspace Files](../api/workspace-files/README.md) — authorized bounded source reads.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
