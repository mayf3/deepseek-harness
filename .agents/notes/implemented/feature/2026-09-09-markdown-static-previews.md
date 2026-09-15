# Agent Note: Static Markdown fence previews

Status: implemented

English | [中文](2026-09-09-markdown-static-previews.zh.md)

## Problem

Readers need an optional way to inspect Mermaid and DOT diagrams and SVG artwork directly in Assistant replies while retaining code as the primary representation. These sources are untrusted, and a renderer's npm license field may omit compiled components with separate distribution obligations.

## Decision

The shared Markdown renderer enables settled `mermaid`, `graphviz`/`dot`, and `svg` fences through localized `MarkdownLabels.preview` and the parsed fence language. The [UI primitives package](../../../../packages/client/ui-primitives/README.md) owns `SourcePreview`, which accepts a renderer, source, and labels without Session, file, or Cordis dependencies. Mermaid and Graphviz each supply a `.ts` renderer to that same component. HTML, consumers without preview labels, and streaming messages retain code.

`CodeBlock.preview` is a standard source-preview descriptor containing the renderer and complete localized output and control labels; callers do not pass React nodes. `MarkdownText` creates one descriptor catalog per preview-label identity, and every settled render reuses its language entries while source text, file mentions, or local-image vocabulary changes. The [CodeBlock interaction decision](2026-09-10-codeblock-preview-interaction.md) supersedes this note's source-first default and release-on-toggle lifetime; it owns the current controls and result retention. The [preview sizing decision](../simplification/2026-09-14-source-sized-code-block-previews.md) owns current geometry. This note retains the independent rendering, security, and distribution decisions.

`SourcePreview` owns pending work, failure, and cancellation of stale result publication. Pending previews show localized status. Source replacement and unmounting cancel publication; cancellation before runtime loading completes skips layout. Failures show a localized error and the original source, and replacing invalid source with valid input recovers the preview.

Mermaid loads on demand. A shared queue serializes theme initialization with diagram work, and each call removes its temporary measurement DOM in `finally`. Strict security, disabled HTML labels, the application palette, and error-rendering policy cannot be overridden by diagram configuration. Parsed flowchart nodes are inspected before layout and image nodes are rejected: Mermaid's strict mode still fetches their resources during layout, before SVG image isolation applies. Generated SVG is displayed as an image without installing links or scripts. Intrinsic dimensions come from the SVG viewBox; large diagrams shrink to fit, and the canvas follows the code-block background. Mounted previews observe document theme attributes and regenerate only when resolved colors change; obsolete renders cannot publish. Graphviz default colors follow the same palette, while authored DOT and SVG colors remain intact.

SVG is parsed as XML and displayed with Graphviz output as inert images, so SVG scripts, links, and external resources never become active. A magnifier opens the body-portaled dialog whose viewport fit, pan, and zoom behavior is owned by the [CodeBlock interaction decision](2026-09-10-codeblock-preview-interaction.md).

Graphviz uses the pinned, unmodified `@viz-js/viz` 3.30.0 WebAssembly distribution with the `dot` layout engine. Its npm MIT declaration covers the wrapper; its build attestation identifies Graphviz 16.0.0 (EPL-2.0), Expat 2.8.4 (MIT), and Emscripten 5.0.7 (MIT/NCSA). Distribution retains these component terms and the exact Graphviz source download under EPL-2.0 section 3.1. [Full preview notices](../../../../packages/client/ui-primitives/THIRD_PARTY_PREVIEW_NOTICES.txt) also retain Mermaid's MIT text and its DOMPurify dependency's selected Apache-2.0 terms. The UI primitives package ships the notices and the Web build emits the same bytes alongside its assets. License review covers embedded payloads separately from the general permissive npm-metadata policy.

Source highlighting uses the shared lazy Shiki highlighter for both streamed and settled diagram fences. SVG resolves to XML; Mermaid selects the upstream grammar's `#mermaid` body rules because CodeBlock has already removed the Markdown fence. DOT uses the MIT TextMate grammar pinned in the [third-party notices](../../../../packages/client/ui-primitives/THIRD_PARTY_PREVIEW_NOTICES.txt), with patterns and scopes preserved by mechanical conversion. This keeps source coloring independent of preview rendering and avoids maintaining a separate DOT tokenizer.

## Alternatives considered

**Show visualization by default with overlay icon actions.** The source-first decision favored authored code and avoided diagram work before an explicit request. The [interaction decision](2026-09-10-codeblock-preview-interaction.md) supersedes that default while retaining actions in the banner.

**Render each streamed chunk.** Incomplete diagrams are frequently invalid, and repeated layout work competes with text streaming. Message settlement provides complete source.

**Put rendering inside Chat or add a general preview registry.** A shared primitive with plain props satisfies reuse without another registry or feature-plugin dependency. This follows the [shared-control rule](../architecture/2026-09-05-shared-client-control-primitives.md).

**Pass rendered JSX through `CodeBlock.preview`.** Caller-created elements split preview ownership between the renderer and the primitive. A standard data descriptor keeps rendering, result ownership, and controls in one component API.

**Preview HTML in a sandboxed frame.** HTML preview adds sanitization, iframe policy, a distinct document layout, and another browser dependency. Source display covers the code-review use case without that separate security and distribution surface.

**Insert rendered markup into Chat.** SVG styles and executable behavior would share the application document. Image mode disables SVG behavior while retaining the rendered result.

**Treat Viz.js as MIT-only or use a remote Graphviz service.** The compiled Graphviz license still applies locally; a remote renderer would send conversation content off-device. The bundled renderer retains source availability and legal notices without network rendering.

## Consequences

The feature changes presentation without changing persisted messages, provider requests, tools, or Host APIs. `SourcePreview` associates a result with both its source and renderer and publishes nothing until the matching result settles. Mermaid and Graphviz add lazy browser assets and run layout on the browser thread. Cancellation cannot preempt active layout; Mermaid finishes and releases its measurement DOM even when its result cannot be published. The previews have no editing, export, HTML rendering, or interactive diagram links.

Component tests cover source copying, preview rendering, delayed completion, stale success and failure, unmounting, fallback, cancellation, runtime loading failure, and recovery. The keyless [browser scenario](../../../../apps/web/tests/markdown-mermaid.e2e.ts) verifies Chinese Mermaid flowcharts, sequence diagrams, malformed source, configuration overrides, inert SVG images, real image decoding, source toggling, English/Chinese UI snapshots, and served license text. Notices checks pin the reviewed wrapper version and native source downloads so upgrades require renewed review.
