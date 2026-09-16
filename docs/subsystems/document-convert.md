# Document conversion

English | [中文](document-convert.zh.md)

The [document package family](../../packages/document/README.md) converts Office files to PDFs on the Node Host. Consumers authorize source reads and own presentation; the shared provider owns conversion, bounded admission, and transient PDF reuse. This subsystem creates no model-facing tool or Session event.

## Ownership

| Owner | Responsibility |
|---|---|
| [document-convert](../../packages/document/document-convert/README.md) | `ctx.documentConvert`: authorized Office bytes and complete PDF results |
| [document-convert-libreoffice](../../packages/document/document-convert-libreoffice/README.md) | Host concurrency, reusable kit converters, private scratch files, and bounded PDF reads |
| [Web bundle](../../packages/bundle/web-app/README.md) | One configurable conversion provider shared by Host consumers |

## Requests and results

[`DocumentConvertRequest`](../../packages/document/document-convert/src/types.ts) contains an already-authorized source key/version, optional stat size, a deferred `read(signal, maxBytes)` callback, foreground/background priority, and a `DocumentExtension`: `doc`, `docx`, `xls`, `xlsx`, `ppt`, or `pptx`. `DocumentConverter.convert(request, signal?)` returns one complete PDF result. Cancellation follows the caller and provider lifetimes; validation, output, and engine failures reject with a classified `DocumentConvertError`.

`DocumentConvertPriority` is `foreground` for requested preview/QA and `background` for speculation. `DocumentSourceKey` brands the caller-owned authorized source locator. `DocumentConverterGeneration` brands a provider lifetime, and `DocumentConvertKey` brands its content identity; neither opaque value is parsed by consumers.

| Result field | Meaning |
|---|---|
| `pdf` | Caller-owned `Uint8Array` containing the complete PDF |
| `missingFonts` | Requested document font families unavailable to this conversion |
| `cacheKey` | Opaque converter generation plus extension/source-content identity |
| `generation` | Provider lifetime; replacement invalidates cached PDF reuse |

The provider admits the deferred read before allocating source bytes, shares conversions by content identity, and removes its private scratch directory before returning. Returned PDF bytes remain valid after provider disposal. Source and PDF bytes do not enter Session storage. Consumers can use [Workspace Files](../../packages/api/workspace-files/README.md) for authorized bounded reads.

## Engine selection and limits

The external [`@deepseek-ai/libreoffice-kit`](https://github.com/deepseek-harness/libreoffice-kit) Node API selects its precompiled engines. The kit has an independent version and release workflow, defined by the [release ownership decision](../../.agents/notes/implemented/architecture/2026-09-14-independent-libreoffice-kit.md). Application builds install the published npm packages. macOS and Windows require their matching ARM64 or x64 native engine; Linux uses Node WASM. The [platform engine decision](../../.agents/notes/implemented/architecture/2026-09-15-platform-office-engines.md) defines installation and packaging. Invalid metadata, missing required assets, and conversion errors reject without switching engines. Conversion uses disk input and output paths on the Host, with no browser conversion engine or font RPC.

The [Host provider configuration](../../packages/document/document-convert-libreoffice/README.md#use-this-package) owns concurrency, deadlines, input/output limits, archive limits, image resolution, and font access. Native/WASM implementation and asset distribution belong to the kit workspace. System LibreOffice discovery, runtime engine downloads, persistent PDF caching, and model-facing rendering are outside this provider.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxdocumentconvert--documentconverter-abstract-seam"></a>

### `ctx.documentConvert` — `DocumentConverter` (abstract seam)

Load one provider subclass per context; consumers own source authorization.

```ts cordis-catalog
/**
 * Convert Office bytes without modifying the source or writing Session events.
 * @param request - authorized metadata and deferred bounded source read.
 * @param signal - caller cancellation; provider disposal also stops active work.
 * @returns caller-owned PDF bytes after conversion and scratch cleanup settle; canceled readers reject independently.
 * @throws {DocumentConvertError} Invalid input, unusable output, or engine failure; cancellation rejects with its reason.
 */
abstract convert(request: DocumentConvertRequest, signal?: AbortSignal): Promise<DocumentConvertResult>
```

Source: [`packages/document/document-convert/src/index.ts`](../../packages/document/document-convert/src/index.ts)
<!-- END GENERATED cordis-surface -->
