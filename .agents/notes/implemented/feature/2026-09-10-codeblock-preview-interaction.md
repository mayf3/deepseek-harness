# Agent Note: CodeBlock preview interaction and retained work

Status: implemented

English | [中文](2026-09-10-codeblock-preview-interaction.zh.md)

## Problem

Readers need to inspect diagrams directly and return to source without paying for the same diagram again. Toolbar state and unrelated grammar notifications can repeat source work even when its text is unchanged.

## Decision

Supported settled blocks initially show Preview. Supported streaming blocks show a 180px image placeholder with a localized loading status and a decorative glyph whose opacity pulses over 1.8 seconds; reduced motion disables the animation. Streaming mounts neither source highlighting nor diagram generation, including after a fence freezes in the incremental parser. Controls return when message streaming ends; the placeholder remains until the image loads. Stopping the stream also exits the waiting state; invalid or unloadable images show an error with Source available. This supersedes the source-first and release-on-toggle choices in the [static preview decision](2026-09-09-markdown-static-previews.md), whose renderer isolation, cancellation, security, and distribution rules remain active.

The language stays on the left. The right side contains magnifier, copy, and Source/Preview controls in that order. Icons follow the Sidebar's 28px circular control and 15px glyph treatment. The segmented control moves only its selected background for 160ms; content switches immediately, and reduced-motion settings suppress that transition. Unsupported blocks have a static selected Source label. Copy always reads source, and its fixed-size icon and localized tooltip show success. Preview provides a magnifier that opens `PreviewLightbox`, disabled with an accessible localized explanation when no usable image is available. Source replaces it with a line-number toggle whose state survives view changes. Preview toolbar opacity transitions over 160ms without a timer or layout change; block hover and keyboard focus reveal it, and touch devices keep it visible. Source toolbar opacity stays at one.

The stable `data-code-block-content` wrapper and `contentRef` let sidebar owners retain their scrollport and restore scroll position. The [preview sizing decision](../simplification/2026-09-14-source-sized-code-block-previews.md) supersedes this note's active-body height and inline-resize choices; it owns current Source/Preview geometry and overflow.

Each mounted `CodeBlock` owns its preview result and pending renderer call. A shared IntersectionObserver defers diagram work and runtime loading until intersection, and cancels unfinished work on exit unless the lightbox is open. Browsers without this API render immediately. Switching views retains completed results; source, renderer, or resolved-theme changes invalidate the work, and unmounting cancels publication. Reentry reuses results with matching source, renderer and palette. Theme refreshes retain the loaded image, its geometry and the open lightbox until a replacement loads. A failed refresh preserves the usable image and displays the localized error. Retention is bounded to one displayed image and one replacement per block.

The owner retains failures too, so toggling cannot repeatedly submit invalid source. Previewable blocks mount source on first selection, then retain that DOM with its highlighting state. `CodeBlock`, its source child, and its copy control are independently memoized. Grammar readiness snapshots report only the source language, so loading another grammar does not schedule source work. This is local retention, with no cache shared across blocks or Sessions.

The lightbox fits the image within 88% of viewport width and 84% of viewport height, independently of inline size. Pointer capture owns dragging; wheel zoom preserves the image point beneath the cursor and stays between 0.25 and 8 times the fitted size. Double-click, Home, source-image changes, and viewport resizing restore the fit. Arrow keys pan and +/− zoom. Gestures write only the image transform and retain its URL; they do not schedule React state or diagram generation. Closing releases capture and listeners and restores focus to the opener.

The source renderer consumes each highlight frame once. `StreamingHighlightSession.updateFrame` returns the same delta frame for repeated code and language, while refs retain completed-line groups across React render retries. The line cache therefore retains the frame identity and returns its existing body for the same frame, code, and language; memoization alone cannot prevent duplicate line insertion. StrictMode coverage checks multiple streaming chunks and settlement, and the Markdown DOM fixtures run under StrictMode without changing their expected output.

## Alternatives considered

**Unmount inactive content.** Releasing images on every Source visit repeats diagram generation and removes the source-view magnifier's result. Retaining one result per mounted block gives the result the same lifetime as its controls.

**Share a global preview cache.** Cross-block reuse adds eviction, renderer identity, and theme-key ownership while retaining conversation content beyond individual mounts. The measured repeated work occurs within one block, so its mounted lifetime is sufficient.

**Mount and highlight source before selection.** The retained image determines block dimensions, so hidden source adds work without improving the preview.

## Consequences

Previewable blocks mount and highlight source on first selection; preview-only readers do not mount source. Ordinary source-only blocks still defer highlighting until they intersect; streaming diagram placeholders do not mount source.

Offscreen previews submit no diagram work until intersection; offscreen theme changes wait for reentry. Returning to Source keeps the image and renderer owner alive, and blocks whose Source view has been opened retain source token DOM. Memory therefore follows mounted blocks, with no claim of reduced heap use. Mermaid's queue and synchronous Graphviz layout still run on the browser thread, and cancellation cannot preempt active layout.

The [viewport tests](../../../../packages/client/ui-primitives/tests/highlight-viewport.client.spec.tsx) pin deferred rendering, viewport cancellation and reuse; the 20-block regression calls every renderer against the unoptimized implementation. The [component tests](../../../../packages/client/ui-primitives/tests/source-preview.client.spec.tsx) cover retained results, source identity, pending and failed controls, copy, streaming transitions, invalidation, and stale publication. The [browser scenario](../../../../apps/web/tests/markdown-mermaid.e2e.ts) exercises equal Source/Preview geometry, internal overflow, toolbar fading, line-number controls, lightbox interaction, and localized UI snapshots. Highlighting retains the existing streamed/settled parity tests. The streaming browser scenario waits for the turn to finish persisting before closing Session handles, including after failed assertions.


## Performance evidence

The [manual browser diagnostic](../../../../apps/web/tests/diagram-preview.perf.ts), run with `pnpm run test:web:perf:built apps/web/tests/diagram-preview.perf.ts`, uses 20 Mermaid flowcharts with 10 nodes and 12 edges each, followed by 40 paragraphs. Three fresh Chromium instances use a 1680×1000 viewport, the shipped Web composition and built Client on macOS arm64, Apple M5 Pro and Node 24.20.0. Opening starts at a real Session click and ends when the tail is visible plus two animation-frame opportunities; theme timing starts immediately before system-theme emulation and ends after a visible replacement plus two frames. These endpoints do not measure hardware presentation or model latency.

| Metric | Eager previews, samples → median | Viewport previews, samples → median |
| --- | --- | --- |
| Open endpoint (ms) | 129.0, 167.3, 98.5 → 129.0 | 72.1, 106.6, 81.7 → 81.7 |
| Long tasks in first 3 seconds (ms) | 61, 58, 0 → 58 | 0, 0, 0 → 0 |
| Additional initial JS transfer (bytes) | 239449 in every sample | 0 in every sample |
| Initially decoded offscreen diagrams | 20 in every sample | 0 in every sample |
| Visible theme replacement (ms) | 956.0, 617.6, 697.7 → 697.7 | 93.0, 93.1, 82.1 → 93.0 |
| Theme placeholder frames / height range | 2 / 180–632px in every sample | 0 / 632–632px in every sample |

Theme preparation scrolls to the loaded target after cold diagrams settle; otherwise an earlier diagram's growth can move the target outside the viewport. Both compared theme phases contain two intersecting previews. First activation and its geometry changes are excluded from timing. Unrelated host activity and filesystem caches are uncontrolled; timings are descriptive, with no CI timing threshold or memory claim. The owning component regression fails on eager rendering, and the browser case verifies deferred Mermaid and Graphviz requests plus a keyless offscreen-state snapshot.
