# Agent Note: Browser Excel preview with saved formula results

Status: implemented

English | [中文](2026-09-16-browser-excel-preview.zh.md)

## Problem

PDF conversion loses spreadsheet navigation and the relationship between a formula and its saved value. Spreadsheet preview also needlessly depends on the Host Office engine when the browser can read the workbook.

## Decision

The [document preview](../../../../packages/client/ui-sidebar-documentpreview/README.md#excel-preview) opens XLSX with FortuneSheet and a package-local ExcelJS adapter. The adapter accepts bytes and limits and returns worksheet data; it has no React state setters, timers, or component references. ExcelJS owns OOXML parsing, while the adapter owns the display mapping. The existing complete-file reader retains Session authorization, file versions, reload, and transient bytes.

Preview is read-only and retains formula text alongside saved results. It does not recalculate, so unsupported functions cannot replace a valid saved result with an error. A formula without a saved result remains blank with a workbook notice. The spreadsheet is neither an authoring tool nor a full Excel rendering engine.

A disposable browser Worker contains parser CPU work. A compressed-byte limit precedes parsing, a combined rectangular-area limit precedes FortuneSheet matrix allocation, and a timeout terminates stalled parsing. These limits do not claim a hard memory sandbox. Styles are scoped to the renderer; external hyperlinks are text only.

The pinned FortuneSheet React dependency carries a [small patch](../../../../patches/@fortune-sheet__react@1.0.4.patch) that skips the input box's read-only layout state update unless formula-reference highlighting is enabled. The unconditional update otherwise causes a maximum-update-depth failure when switching worksheets under React 19. Sheet activation also retains the adapter's complete initial selection instead of clearing it and leaving an empty or invalid address. The browser scenario covers these failures through the bundled ESM entry; the CommonJS entry receives the same fixes. Recheck this patch when upgrading FortuneSheet.

## Alternatives considered

**Adopt FortuneExcel's React-oriented conversion helper.** Its component setters and post-render sizing couple file conversion to one UI lifecycle. The local adapter can be tested without mounting a workbook and needs no second intermediate workbook model.

**Write an OOXML parser or create a new public package.** ExcelJS already owns the container and file semantics. One preview consumer does not justify another public API, Cordis service, or generic workbook abstraction; a second independent consumer can motivate extraction.

**Keep PDF as an Excel fallback or calculate every formula on import.** PDF retains neither spreadsheet interaction nor formula inspection, while recalculation can change saved results. Legacy XLS receives explicit XLSX guidance. The [Office engine decision](../architecture/2026-09-11-node-office-kit.md) remains applicable to Word/PowerPoint previews and independent conversion consumers; its conversion capability still supports spreadsheets.

## Consequences

The renderer trades complete Excel fidelity for browser-local navigation and reusable conversion code. The package README owns supported formats, resource defaults, and unsupported features. Real XLSX fixtures cover conversion, Worker tests cover cancellation and cleanup, and the shipped-profile browser scenario opens a workbook with Office conversion disabled and copies a saved XLOOKUP result under read-only settings.
