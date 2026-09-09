# Agent Note: Static Markdown fence previews

Status: implemented

English | [中文](2026-09-09-markdown-static-previews.zh.md)

## Problem

Readers need to see DOT diagrams, SVG artwork, and HTML examples directly in Assistant replies. These sources are untrusted, and a renderer's npm license field may omit compiled components with separate distribution obligations.

## Decision

The shared Markdown renderer enables settled `graphviz`/`dot`, `svg`, and `html` fences through localized `MarkdownLabels.preview`. `CodeBlock.preview` owns default visualization, source switching, and verbatim copying. `SourcePreview` owns loading, failure, and cancellation of stale result publication for both these documents and the [Mermaid preview](2026-09-07-web-mermaid-preview.md). Consumers without preview labels and streaming messages retain code.

HTML uses DOMPurify with navigation attributes and document-loading elements forbidden, followed by an opaque `sandbox=""` iframe. A trusted CSP precedes source markup and permits only inline CSS, data images, and data fonts. Scripts, external resources, child frames, form submission, and same-origin access are unavailable. SVG is parsed as XML and placed in an image inside the frame, so SVG scripts and links never become active. Frames have a fixed scrollable viewport: measuring their content would require additional origin access or trusted frame scripts. Mermaid keeps its existing strict renderer and inert image presentation.

Graphviz uses the pinned, unmodified `@viz-js/viz` 3.30.0 WebAssembly distribution with the `dot` layout engine. Its npm MIT declaration covers the wrapper; its build provenance identifies Graphviz 16.0.0 (EPL-2.0), Expat 2.8.4 (MIT), and Emscripten 5.0.7 (MIT/NCSA). Distribution retains these component terms and the exact Graphviz source download under EPL-2.0 section 3.1. [Full preview notices](../../../../packages/client/ui-primitives/THIRD_PARTY_PREVIEW_NOTICES.txt) also retain Mermaid's MIT text and select Apache-2.0 for DOMPurify. The UI primitives package ships the notices and the Web build emits the same bytes alongside its assets. License review covers embedded payloads separately from the general permissive npm-metadata policy.

## Alternatives considered

**Execute HTML scripts in a frame.** Static chat examples do not need script execution. An empty sandbox plus sanitization and CSP gives the preview fewer capabilities and avoids introducing a frame messaging protocol.

**Insert rendered markup into Chat.** HTML styles and executable SVG would share the application document. Iframes isolate layout and origin; SVG image mode additionally disables SVG behavior.

**Treat Viz.js as MIT-only or use a remote Graphviz service.** The compiled Graphviz license still applies locally; a remote renderer would send conversation content off-device. The bundled renderer retains source availability and legal notices without network rendering.

## Consequences

No Session event, prompt, or tool changes. Inline HTML styles work, while interactive scripts, external assets, and links do not. Graphviz adds a lazy WebAssembly asset and synchronous browser-thread layout; source cancellation prevents publication but cannot preempt active layout. Mermaid's existing layout limitations remain documented in its owning note.

Component tests cover source copying, default preview, fallback, cancellation, and recovery. The keyless [browser scenario](../../../../apps/web/tests/markdown-mermaid.e2e.ts) verifies opaque frames, real image decoding, source toggling, blocked script/navigation/resource attempts, locale snapshots, and served license text. Notices checks pin the reviewed wrapper and native provenance so upgrades require renewed review.
