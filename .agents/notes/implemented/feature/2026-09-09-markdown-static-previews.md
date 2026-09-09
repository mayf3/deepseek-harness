# Agent Note: Static Markdown fence previews

Status: implemented

English | [中文](2026-09-09-markdown-static-previews.zh.md)

## Problem

Readers need to see Mermaid and DOT diagrams, SVG artwork, and HTML examples directly in Assistant replies without interpreting source or copying it to another renderer. These sources are untrusted, and a renderer's npm license field may omit compiled components with separate distribution obligations.

## Decision

The shared Markdown renderer enables settled `mermaid`, `graphviz`/`dot`, `svg`, and `html` fences through localized `MarkdownLabels.preview` and the parsed fence language. The [UI primitives package](../../../../packages/client/ui-primitives/README.md) owns `SourcePreview`, which accepts a renderer, source, and labels without Session, file, or Cordis dependencies. Mermaid and Graphviz each supply a `.ts` renderer to that same component. Consumers without preview labels and streaming messages retain code.

`CodeBlock.preview` owns default visualization, source switching, and verbatim copying. Previews omit the language banner and expose compact icon actions on hover or keyboard focus; devices with any touch input keep actions visible below the diagram. Switching to source hides the mounted preview, preserving completed rendering and pending work. Both views use the same focused toggle button, and copying always reads the source prop.

`SourcePreview` owns loading, failure, and cancellation of stale result publication. Source replacement and unmounting cancel publication; cancellation before runtime loading completes skips layout. Failures show a localized error and the original source, and replacing invalid source with valid input recovers the preview.

Mermaid loads on demand. A shared queue serializes theme initialization with diagram work, and each call removes its temporary measurement DOM in `finally`. Strict security, disabled HTML labels, the application palette, and error-rendering policy cannot be overridden by diagram configuration. Generated SVG is displayed as an image without installing links or scripts. Intrinsic dimensions come from the SVG viewBox; large diagrams shrink to fit, and the canvas follows the code-block background. Mounted previews observe document theme attributes and regenerate only when resolved colors change; obsolete renders cannot publish. Graphviz default colors follow the same palette, while authored DOT, SVG, and HTML colors remain intact.

HTML uses DOMPurify with navigation attributes and document-loading elements forbidden, followed by an opaque `sandbox=""` iframe. A trusted CSP precedes source markup and permits only inline CSS, data images, and data fonts. Scripts, external resources, child frames, form submission, and same-origin access are unavailable. SVG is parsed as XML and placed in an image inside the frame, so SVG scripts and links never become active. Frames have a fixed scrollable viewport: measuring their content would require additional origin access or trusted frame scripts.

Graphviz uses the pinned, unmodified `@viz-js/viz` 3.30.0 WebAssembly distribution with the `dot` layout engine. Its npm MIT declaration covers the wrapper; its build provenance identifies Graphviz 16.0.0 (EPL-2.0), Expat 2.8.4 (MIT), and Emscripten 5.0.7 (MIT/NCSA). Distribution retains these component terms and the exact Graphviz source download under EPL-2.0 section 3.1. [Full preview notices](../../../../packages/client/ui-primitives/THIRD_PARTY_PREVIEW_NOTICES.txt) also retain Mermaid's MIT text and select Apache-2.0 for DOMPurify. The UI primitives package ships the notices and the Web build emits the same bytes alongside its assets. License review covers embedded payloads separately from the general permissive npm-metadata policy.

## Alternatives considered

**Keep the code banner above diagrams.** A language label and permanent text controls distract from the diagram. Overlay actions retain source access without reserving a title row.

**Render each streamed chunk.** Incomplete diagrams are frequently invalid, and repeated layout work competes with text streaming. Message settlement provides complete source.

**Put rendering inside Chat or add a general preview registry.** A shared primitive with plain props satisfies reuse without another registry or feature-plugin dependency. This follows the [shared-control rule](../architecture/2026-09-05-shared-client-control-primitives.md).

**Execute HTML scripts in a frame.** Static chat examples do not need script execution. An empty sandbox plus sanitization and CSP gives the preview fewer capabilities and avoids introducing a frame messaging protocol.

**Insert rendered markup into Chat.** The requested preview needs diagram display and source access; HTML styles and executable SVG would share the application document. Iframes isolate layout and origin; SVG image mode additionally disables SVG behavior.

**Treat Viz.js as MIT-only or use a remote Graphviz service.** The compiled Graphviz license still applies locally; a remote renderer would send conversation content off-device. The bundled renderer retains source availability and legal notices without network rendering.

## Consequences

The feature changes presentation without changing persisted messages, provider requests, tools, or Host APIs. Inline HTML styles work, while interactive scripts, external assets, and links do not. Mermaid and Graphviz add lazy browser assets and run layout on the browser thread. Cancellation cannot preempt active layout; Mermaid finishes and releases its measurement DOM even when its result cannot be published. The previews have no editing, export, zoom controls, or interactive diagram links.

Component tests cover source copying, default preview, delayed completion, stale success and failure, unmounting, fallback, cancellation, runtime loading failure, and recovery. The keyless [browser scenario](../../../../apps/web/tests/markdown-mermaid.e2e.ts) verifies Chinese Mermaid flowcharts, sequence diagrams, malformed source, configuration overrides, opaque frames, real image decoding, source toggling, blocked script/navigation/resource attempts, English/Chinese UI snapshots, and served license text. Notices checks pin the reviewed wrapper and native provenance so upgrades require renewed review.
