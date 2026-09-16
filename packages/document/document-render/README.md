---
description: "Authorized Office input and complete PDF output for Host conversion providers."
kind: "package-reference"
---

# @deepseek-ai/dsh-document-render

English | [中文](README.zh.md)

## Summary

Convert authorized `.doc`, `.docx`, `.xls`, `.xlsx`, `.ppt`, and `.pptx` bytes to a complete PDF. Callers receive PDF bytes and, for OOXML inputs, missing-font families without changing the original file or adding model context.

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

Mount the [LibreOffice provider](../document-render-libreoffice/README.md) to supply `ctx.documentRender`. The abstract service has no mountable implementation or configuration. Callers authorize and stat their source before passing its identity, version, optional byte size, deferred bounded read, Office extension, and scheduling priority to `render()`. The provider admits metadata before calling the read callback. A changed source version rejects conversion.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Providers return independent caller-owned PDF bytes, a conversion cache key, and their rendering generation. Consumers check `generation` before reusing cached PDFs; configuration replacement creates a new generation. Individual reader cancellation rejects promptly; provider disposal waits for actual reads, conversion, and scratch cleanup. Cancellation rejects with its reason; classified conversion failures use `DocumentRenderError`. Providers and consumers share this package as a peer dependency so `instanceof DocumentRenderError` recognizes their failures. No runtime invariant companion is published because this service declares operations without an independent retained observation.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Document rendering](../../../docs/subsystems/document-render.md) — composition and ownership.
- [Workspace Files](../../api/workspace-files/README.md) — Session file authorization and bounded reads.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package converts bytes without model-facing tools, messages, or Session events.

#### KV Cache effect

None; conversion does not construct or modify model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The service accepts only the six listed Office formats; source authorization belongs to consumers, while shared conversion reuse belongs to the provider.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
