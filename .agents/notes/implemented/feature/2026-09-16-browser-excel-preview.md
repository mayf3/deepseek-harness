# Agent Note: Browser Excel preview with saved formula results

Status: implemented

English | [中文](2026-09-16-browser-excel-preview.zh.md)

## Problem

PDF conversion loses spreadsheet navigation and the relationship between a formula and its saved value. Spreadsheet preview also needlessly depends on the Host Office engine when the browser can read the workbook.

## Decision

The [document preview](../../../../packages/client/ui-sidebar-documentpreview/README.md#excel-preview) opens XLSX, XLS, CSV, and TSV with FortuneSheet and package-local adapters for ExcelJS, SheetJS CE, and PapaParse. The adapter accepts bytes, format, and limits and returns worksheet data; it has no React state setters, timers, or component references. Dependencies own file parsing, while the adapters share display formatting and initial selection without introducing another workbook model. CSV/TSV retain literal strings and a plain-text option; implicit type inference could otherwise discard leading zeros or interpret source text as formulas. The shared document reader calls `remote.workspaceFiles.readBytes(sessionId, path, {}, signal)` and receives native bytes through the binary Remote, retaining Session authorization, file versions, reload, and transient bytes without base64 decoding. Workspace Files owns bounded file reads; format parsing stays in the Client. The registration marks only XLSX/XLS as `binaryExtensions`, so the shared document container offers Plain text for CSV/TSV. Each renderer registers its body under its own id.

Preview is read-only and retains formula text alongside saved results. It does not recalculate, so unsupported functions cannot replace a valid saved result with an error. A formula without a saved result remains blank. Workbooks containing formulas show a compact warning beside the formula icon instead of consuming worksheet height with a notice row. The spreadsheet is neither an authoring tool nor a full Excel rendering engine.

A disposable browser Worker contains parser CPU work. A source-byte limit precedes parsing, a combined rectangular-area limit precedes FortuneSheet matrix allocation, and a timeout terminates stalled parsing. These limits do not claim a hard memory sandbox. Styles are scoped to the renderer; external hyperlinks are text only.

The pinned FortuneSheet React dependency carries a [patch](../../../../patches/@fortune-sheet__react@1.0.4.patch) that skips the input box's read-only layout state update unless formula-reference highlighting is enabled. The unconditional update otherwise causes a maximum-update-depth failure when switching worksheets under the shipped React 18.3.1 runtime. Sheet activation also retains the adapter's complete initial selection instead of clearing it and leaving an empty or invalid address. The browser scenario covers these failures through the bundled ESM entry.

The read-only formula bar takes formulas from raw `cell.f` and writes formulas and cell text through `textContent`. FortuneSheet's formula formatter emits HTML spans containing document text, and its HTML helper passes formulas and strings starting with `<span` through unchanged. Neither read-only mode nor the parser Worker isolates this DOM. The [core patch](../../../../patches/@fortune-sheet__core@1.0.4.patch) HTML-escapes copied cell contents, including literal strings and saved formula results, while preserving the clipboard table and formatting.

The ESM and CommonJS entries receive the same patches. Recheck worksheet switching, complete initial selections, literal formula-bar text, and escaped table copying when upgrading FortuneSheet.

## Alternatives considered

**Adopt FortuneExcel's React-oriented conversion helper.** Its component setters and post-render sizing couple file conversion to one UI lifecycle. The local adapter can be tested without mounting a workbook and needs no second intermediate workbook model.

**Write an OOXML parser or create a new public package.** ExcelJS already owns the container and file semantics. One preview consumer does not justify another public API, Cordis service, or generic workbook abstraction; a second independent consumer can motivate extraction.

**Keep PDF as an Excel fallback or calculate every formula on import.** PDF retains neither spreadsheet interaction nor formula inspection, while recalculation can change saved results. The [Office engine decision](../architecture/2026-09-11-node-office-kit.md) remains applicable to Word/PowerPoint previews and independent conversion consumers; its conversion capability still supports spreadsheets.

## Consequences

The renderer trades complete Excel fidelity for browser-local navigation and reusable conversion code. The package README owns supported formats, resource defaults, and unsupported features. Real XLSX/XLS fixtures and delimited-text cases cover conversion, Worker tests cover cancellation and cleanup, and the shipped-profile browser scenario opens a workbook with Office conversion disabled and copies a saved XLOOKUP result under read-only settings. It also exercises XLS sheet switching and CSV/TSV literal copying, text-view switching, and reload. SheetJS CE is pinned to its official release tarball because the public npm registry is stale; its Apache-2.0 license follows the existing permissive-license and bundled-notice policy.
