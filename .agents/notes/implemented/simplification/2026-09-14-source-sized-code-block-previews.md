# Agent Note: Diagram-sized code block previews

Status: implemented

English | [中文](2026-09-14-source-sized-code-block-previews.zh.md)

## Problem

Source line count does not predict diagram proportions. Sizing a preview from hidden highlighted source can clip a tall diagram, waste space around a short one, and parse a large source tree before the reader requests it. Independent Source and Preview heights move the surrounding transcript on every toggle.

## Decision

The browser sizes the retained preview image from its intrinsic aspect ratio and available width. CSS limits image height to the smaller of 60vh and 640px; the canvas adds 16px padding and a 120px minimum height. The image remains in document flow while hidden, so both views keep the same geometry through toggles and viewport resizing without JavaScript measurements or resize state.

Source mounts on first selection, overlays the preview area, and scrolls internally. Subsequent toggles retain the source DOM and generated image. Preview remains the default. Supported streaming fences keep the 180px placeholder and mount neither source nor the diagram renderer until settlement.

`CodeBlock` exposes no inline resize controls. Enlarging the image opens the existing lightbox with pan, zoom, and viewport fit.

## Alternatives considered

**Use hidden source as the size owner.** Source length and wrapping do not describe the diagram, and eagerly highlighting it adds work to the default preview path.

**Give each view its own natural height or allow drag resizing.** Independent heights move transcript content; manual resizing adds state and controls where the browser can derive the size from the image.

## Consequences

Preview-only readers do not mount or highlight source. Source-only blocks retain viewport-triggered highlighting. Very tall diagrams scale down in the transcript; the lightbox provides detailed reading. Source DOM remains allocated after the reader first opens it, preserving highlight and scroll state across toggles.

Browser regressions cover wide and narrow viewports, short and tall images, stable toggle geometry, retained DOM, and hidden-source accessibility. Component tests verify that preview settlement performs no source highlighting before Source is selected.
