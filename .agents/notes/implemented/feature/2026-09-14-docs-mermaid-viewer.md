# Agent Note: Documentation Mermaid viewer

Status: implemented

English | [中文](2026-09-14-docs-mermaid-viewer.zh.md)

## Problem

Complex Mermaid diagrams lose readable detail when scaled to the documentation column. Long sequence diagrams need both magnification and movement to inspect interactions while retaining an overview.

## Decision

The [VitePress theme](../../../../website/.vitepress/theme/index.ts) adds a fullscreen entry above each rendered Mermaid SVG. A native modal dialog provides an inert background and Escape dismissal; the toolbar cycles keyboard focus through zoom, fit, and close controls. Panzoom supplies pointer, wheel, and pinch interaction. Arrow keys pan in fixed screen distances. Closing restores the entry's focus without scrolling and restores the page's previous overflow setting.

The viewer copies the SVG into a shadow root. Mermaid's embedded selectors and fragment IDs stay local to the copy, so its markers and styles cannot resolve against the original diagram. Panzoom transforms a viewport-sized canvas containing the SVG at its natural viewBox dimensions, so pointer coordinates and the transform origin share the same center; the initial scale and every resize fit the entire diagram without enlarging it beyond its natural size. This preserves vector detail while keeping fit independent of the narrow document column.

Viewer resources belong to the mounted theme. Route, language, theme, and source-SVG replacement close the active view; asynchronous Mermaid renders receive a fresh entry. The scroll lock belongs on the body because the Mermaid plugin observes every attribute change on the HTML element and rerenders in response. The [implementation](../../../../website/.vitepress/theme/mermaid-viewer.ts) leaves Markdown, raw page copies, and `llms.txt` generation with their existing owners.

## Alternatives considered

**Widening the document column.** A wider column cannot provide readable detail for arbitrarily large diagrams, and long diagrams still exceed the viewport.

**A custom overlay with document-wide listeners.** A native dialog already makes the background inert and handles modal dismissal. Theme-owned resources make navigation and teardown explicit; persistent document listeners would require a separate lifetime mechanism.

**A bitmap preview or a same-document SVG clone.** A bitmap loses vector detail at high zoom. A same-document clone duplicates Mermaid's IDs and embedded styles; rewriting all SVG and CSS references would add a parser obligation that a shadow root avoids.

## Consequences

The website gains Panzoom as a direct dependency and uses native dialog, shadow-root, and resize-observer support. Viewer zoom and position are transient: resizing refits the diagram, and navigating or changing the theme closes it. Existing page diagrams remain the reading and link-navigation source.

The [focused tests](../../../../website/tests/mermaid-viewer.spec.ts) cover late rendering, fit dimensions, control wiring, keyboard cycling, replacement, and resource release through `docs:check` and `doc-sync`. Real-browser verification remains necessary for native modal behavior, SVG marker rendering, drag and wheel transforms, themes, and narrow viewports; DOM-only tests do not establish those browser behaviors.
