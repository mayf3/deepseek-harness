# Agent Note: Mermaid previews in Chat code fences

Status: implemented

English | [中文](2026-09-07-web-mermaid-preview.zh.md)

## Problem

Assistant replies can describe diagrams in Mermaid code fences, but readers must interpret the source or copy it to another renderer. Rendering must handle incomplete streaming input and untrusted diagram content while remaining reusable outside Chat.

## Decision

Chat enables settled fence previews through `MarkdownLabels.mermaid`. The shared Markdown renderer uses the parsed fence language; streaming fences and consumers without those labels retain code display. The static [UI primitives package](../../../../packages/client/ui-primitives/README.md) owns `MermaidPreview`, which accepts source and localized labels without Session, file, or Cordis dependencies. `CodeBlock.preview` owns view switching and source copying. Previews omit the language banner and expose compact icon actions on hover or keyboard focus; devices with any touch input keep those actions visible below the diagram. Switching to source hides the mounted preview, so returning preserves completed rendering and pending work. Source and preview share the same focused toggle button, and copying always reads the source prop.

Mermaid loads on demand. Its public render API serializes diagram work, and each call removes its temporary measurement DOM in `finally`. Strict security, disabled HTML labels, the neutral theme, and error-rendering policy cannot be overridden by diagram configuration. Generated SVG is displayed as an image without installing diagram links or scripts. Intrinsic dimensions come from the SVG viewBox; large diagrams shrink to fit, and the canvas stays light in both application themes.

Source replacement and unmounting cancel result publication. Cancellation before runtime loading completes prevents rendering; an active Mermaid render finishes and releases its DOM but cannot publish to a cancelled component. Failures show a localized error and the original source. Replacing invalid source with a valid diagram recovers the preview.

## Alternatives considered

**Keep the code banner above diagrams.** A language label and permanent text controls distract from the diagram. Overlay actions retain source access without reserving a title row.

**Render each streamed chunk.** Incomplete diagrams are frequently invalid, and repeated layout work competes with text streaming. The existing message-settlement boundary provides a complete source value.

**Put rendering inside Chat or add a general preview registry.** A shared primitive with plain props satisfies reuse without another registry or feature-plugin dependency. This follows the [shared-control rule](../architecture/2026-09-05-shared-client-control-primitives.md).

**Insert interactive SVG into the message.** The requested preview needs diagram display and source access. Displaying the result as an image keeps diagram links and event handlers inactive.

The [static fence preview decision](2026-09-09-markdown-static-previews.md) owns Graphviz, SVG, and HTML sandboxing and shared preview license distribution.

## Consequences

The feature changes presentation without changing persisted messages, provider requests, tools, or Host APIs. Mermaid adds lazily loaded browser assets. Rendering still runs on the browser thread, and work already handed to the library cannot be interrupted. The initial feature has no editing, export, zoom controls, or interactive diagram links.

Component tests cover delayed completion, stale success and failure, unmounting, source fallback, and copying. The keyless [browser scenario](../../../../apps/web/tests/markdown-mermaid.e2e.ts) exercises the assembled Chat with Chinese flowcharts, sequence diagrams, malformed source, configuration overrides, and English/Chinese UI snapshots.
