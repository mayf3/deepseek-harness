---
description: "Package map for Host Office conversion and reusable PDF results."
kind: "package-group"
---

# document/ — Office conversion

English | [中文](README.zh.md)

## Summary

Convert authorized Office files to reusable PDFs on the Host. The conversion family provides a shared conversion operation and a LibreOffice kit provider. Targets with a declared native engine use it; other targets use Node WASM.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Each package owns its configuration and lifetime rules; the subsystem reference describes their shared conversion operation.

| Package | Role | ctx key |
|---|---|---|
| [document-convert](document-convert/README.md) | Authorized Office bytes to complete PDF results | `ctx.documentConvert` |
| [document-convert-libreoffice](document-convert-libreoffice/README.md) | Host kit provider with cancellable concurrency and private scratch files | `ctx.documentConvert` |

-----

<a id="related-documentation"></a>
## Related documentation

Consumers own source authorization and presentation.

- [Document conversion](../../docs/subsystems/document-convert.md) — shared operation and generated service reference.
- [Independent kit ownership](../../.agents/notes/implemented/architecture/2026-09-14-independent-libreoffice-kit.md) — engine distribution and application integration.
- [Workspace Files](../api/workspace-files/README.md) — authorized bounded source reads.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
