# Agent Note: Page Markdown actions in the documentation site

Status: implemented

English | [中文](2026-09-15-docs-page-markdown-actions.zh.md)

## Problem

Readers need a visible way to obtain one documentation page as Markdown. The published text must retain its current language and projected links. A browser fetch also shares its development URL with Vite's page-module imports, so treating every Markdown request as source text breaks navigation.

## Decision

The [projector](../../../../scripts/project-doc-site.ts) supplies ordinary content pages with a `rawMarkdownPath` from the publication manifest. The [theme](../../../../website/.vitepress/theme/index.ts) combines that path with the site base and exposes copy and view actions above the document. Directory pages use their full `index.md` route, which preserves the same relative-link location in development and static builds. Redirect homes and missing pages have no actions. Raw output excludes projection metadata.

The [development middleware](../../../../website/raw-markdown.ts) admits explicitly marked `?dsh-raw=1` browser fetches and returns 404 for unpublished raw routes. Script imports always reach Vite. The view link opens the ordinary raw URL in a new tab; copy reads that same projected body on demand. Neither operation reconstructs Markdown from the rendered DOM.

The [copy component](../../../../website/.vitepress/theme/page-markdown-actions.ts) calls `clipboard.write` within the click gesture and supplies a promise-backed `text/plain` ClipboardItem. Awaiting the network first would lose user activation in browsers that require it. Each route and language gets its own keyed component instance; disposal aborts unfinished data reads and prevents old writes from changing new-page feedback. A system clipboard write that has already consumed its data cannot be withdrawn. Request and clipboard failures provide localized manual-copy guidance, and success follows the completed write. Denied writes may never consume their data promise, so that promise has its own rejection observer.

## Alternatives considered

**Derive the raw URL from the browser location.** Clean URLs, directory indexes, language prefixes, and deployment bases make this less reliable than the projector's known route.

**Serve every Markdown fetch as source text.** Vite imports the same URLs as JavaScript modules. An explicit request marker keeps source retrieval separate while static hosting still serves the emitted file.

**Fetch first, then call `writeText`.** This can work in Chromium but loses the initiating gesture across the network wait in other browsers. Promise-backed clipboard data preserves that gesture without prefetching pages.

## Consequences

Automatic copying requires the browser's asynchronous ClipboardItem write API in a secure context. Unsupported or denied writes retain the view link for manual copying. Page copy state is transient and belongs to one route; it creates no Session data or model request.

The [component tests](../../../../website/tests/page-markdown-actions.spec.ts) pin localized accessible output beside their owner and exercise deferred reads, denied writes, and navigation disposal. The [middleware tests](../../../../website/tests/raw-markdown.spec.ts) cover request dispatch. Both run through the unit suite, `docs:check`, and `doc-sync`. The [Mermaid viewer decision](2026-09-14-docs-mermaid-viewer.md) retains its independent rendering and resource-lifetime rules.

**CI coverage gap.** DOM tests simulate the clipboard and do not execute native user-activation rules, actual paste, or responsive layout. Development and static-preview browser verification remains necessary, including both locales and site bases. No real model round participates in this static-document feature.
