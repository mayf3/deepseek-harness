---
description: "Shared React UI atoms for the dsh web client: controls, icons, markdown and math rendering, and the terminal/read/diff/search/web output cards (zero Cordis)."
kind: "package-library"
---

# @deepseek-ai/dsh-client-ui-primitives

English | [中文](README.zh.md)

## Summary

Use `dsh-client-ui-primitives` to build web-client controls and render agent output with shared React UI. It includes standard controls, icons, anchored overlays, and renderers for Markdown with TeX, terminal output, file reads, diffs, search, web retrieval, and JSON. The renderers handle untrusted model output by dropping raw HTML, restricting links, and parsing ANSI escape sequences. The components import no Cordis runtime; callers supply localized labels, and theme-facing colors use `--dsw-*` design tokens.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

This package is a Web-shell build input. Its static ESM retains third-party imports and styles for Vite; independent consumers supply its development dependencies ([dependency rules](../AGENTS.md#dependency-declaration)).

Compose feature UI from these atoms whenever the web client needs a standard control or an agent-output renderer. They render through React only and take `--dsw-*` design tokens from the theme, so they fit any plugin without importing the theme or the slot system.

<a id="component-catalog"></a>
### Component catalog

Check this table before writing a control in a feature package. A plugin cannot import another plugin's component, so this package is the only place a control can be shared: reuse what fits, and lift a deliberate visual difference into a prop rather than starting a second copy.

| Export | What it is |
|---|---|
| `Button` | Clickable action; `variant` selects `primary`, `ghost`, `outline`, or `toolbar`. |
| `Switch` | Two-state toggle, 36×20. `label` is required, so the control cannot ship unnamed. |
| `Checkbox` | Labeled native checkbox with controlled state, keyboard interaction, and disabled styling; the caller supplies localized `label` text. |
| `Input` | Single-line text entry for search boxes and inline forms. |
| `Menu` | Dropdown of items, separators, and group labels, with nested submenus. While open, ↑/↓ (with Home and End) walk the list, Tab settles the focused row, and Escape or Shift+Tab close back to the anchor; selecting a row also returns the keyboard to the anchor unless the owner moved it itself. Only a keyboard on the anchor or inside the list is intercepted, and `autoFocus` decides solely whether opening focuses the first row. |
| `Pill` | Selectable capsule button for view switchers and filters; takes `active` and `onClick`. |
| `Tag` | Read-only capsule badge; `tone` selects one of eight palettes. |
| `StateDot` | Status mark: `done`, `warning`, `ongoing`, `error`, or `idle`. `aria-hidden`, so the render site owns the name. |
| `ConnectionIndicator` | Inline connection-recovery control across outage, retry, and recovered states. |
| `DisclosureRow` | 24px compact disclosure that lays title and content side by side. |
| `Modal` | Centered dialog over a page mask. |
| `RiskConfirmation` | Sensitive action gated behind an explicit checkbox. |
| `OnboardingSurface` | First-run stage that holds the application root inert. |
| `Tooltip` | Hover text on a cloned anchor, placed right, bottom, or top. |
| `HoverCard` | Hover preview the pointer can rest on and select from; optional copy button. |
| `Toast` | Transient top-center banner held for the owner's `holdMs`. |
| `JsonTree`, `JsonBlock` | Read-only JSON inspection. |
| `MarkdownText`, `MarkdownDelegateProvider`, `CodeBlock` | Untrusted GFM with TeX math, owner-delegated HTTP(S) navigation, and highlighted code. `CodeBlock` accepts opt-in `lineNumbers`; copied source excludes the gutter, and `contentRef` exposes its stable source wrapper to an owner that uses it as a scrollport. Set `showHeader={false}` when the owner supplies its own language and copy toolbar. |
| `TerminalBlock`, `ReadBlock`, `DiffBlock`, `SearchBlock`, `WebBlock` | The agent-output card matching each tool-result intent. |
| `icons/*`, `FishLogo`, `BrandWordmark`, `ReferenceIcon`, `LinkIcon` | Glyphs and brand marks. Use `LinkIcon` for 14px clickable-link categories and known-site marks. |
| `FileTypeIcon`, `classifyFileType`, `fileExtension` | A category-colored 28px file or folder glyph and the shared case-insensitive filename mapping behind it. Code and configuration files use detailed full-color technology glyphs; use `LinkIcon` for link-leading glyphs and image previews for image content. |

Three pairs are easy to confuse:

- **`Tag` against `Pill`.** Reach for `Tag` for a read-only badge at the 11px capsule size, and for `Pill` when the capsule is selectable (`active` and `onClick`, as view switchers and filters use) or when it must sit on a 24px text line — `TerminalBlock` renders its exit status as a static `Pill` for exactly that reason. Size decides as much as interactivity here; the two are not interchangeable.
- **`DisclosureRow` against a card.** The row lays its title and content side by side at a fixed 24px. A card that stacks a name over a description is a different layout, and belongs in the feature package — `ui-settings-plugins`' `PluginCard` is the precedent and records why.
- **`FoldToggle` against the exported surface.** It is package-internal and not exported; the output cards use it for their head-tail fold.

Writing your own component in your own package is fine when the need is genuinely specific. What is not fine is copying a control that already exists here — and once a second package needs the same control, it belongs in this package ([decision](../../../.agents/notes/implemented/architecture/2026-09-05-shared-client-control-primitives.md)).

### Controls and icons

The catalog above lists what each export is for; this section covers the behavior that props alone do not show. The `ic_ds_*` icon set and `FishLogo`/`BrandWordmark` marks fill brand and inline-icon slots. `FileTypeIcon` renders the traditional 28px Excel, folder, HTML, image, Markdown, generic, PDF, PPT, video, and Word glyphs, and uses the imported square technology artwork for the established 48 code and configuration categories. The import replaces artwork only: archive-only categories do not extend `CodeFileType`. `classifyFileType` applies exact filename, prefix, suffix, optional project-context, and extension rules in that order; React names win over TypeScript/JavaScript, Angular suffixes win over their base extension, and a Dart file becomes Flutter only when the supplied project files contain a `pubspec.yaml` with `flutter:`. Markdown and SVG remain traditional Markdown and image files. Office mappings include XLSM/Numbers as Excel, KEY as slides, and RTF/ODT/Pages as documents. `fileExtension` exposes the same basename and final-dot parsing for adjacent metadata labels. Traditional glyphs use a solid category-colored sheet with a white mark and translucent white corner; the generic file uses a grey sheet and darker grey corner. Callers may override the sheet color through `--dsh-file-type-icon-color`. The full-color technology artwork is the deliberate exception and retains its embedded palette. All glyphs are decorative and carry no label. `LinkIcon` remains the smaller leading glyph for clickable artifact links — globe, folder, code, image, document, or plain paper, and for a `url` link the mark of a well-known site named by its `href` — the developer sites a transcript usually cites (GitHub, GitLab, npm, PyPI, Stack Overflow, MDN, Wikipedia, Hacker News, YouTube, X, Bilibili, Zhihu, Juejin, CSDN) and mainstream search, video, social, shopping, and reference sites (Google, Baidu, DuckDuckGo, TikTok, Netflix, Spotify, Facebook, Instagram, Reddit, Telegram, WhatsApp, WeChat, QQ, Weibo, Taobao, AliExpress, eBay, Quora, V2EX, Apple) — while `classifyLinkPath` folds the shared file types into that existing six-category vocabulary. `ConnectionIndicator` renders a warning-colored disconnected action whose permanent retry glyph marks the retry action beside the owner-supplied outage label, a connecting spinner beside a label whose one-to-three dots advance every 500ms independently of retry timing, or a success-colored recovered status. Clicking either warning state requests an immediate reconnect; no hover interaction changes the copy. The pill fades in on appearance, fades out for 150ms before unmounting, and sizes to its current label. Its owner supplies visibility, the recovery hold, localized labels, and the immediate-reconnect callback; the primitive uses no native title tooltip. `useAnchoredPosition` and `useAnchoredMaxHeight` keep floating panels and bottom-anchored overlays clamped to the viewport and following their anchor. `HoverCard` keeps its portaled preview reachable across the anchor gap and can expose a copy button through the `copyText` prop. `Toast` holds for the window its owner names through `holdMs`, because how long a banner has to stay depends on how much there is to read; the same value drives its unmount timer and the stylesheet's fade delay, so the two cannot disagree. `rankByName` is the `/` menu's shared candidate ranker for the command and skill sources: the query must be a case-insensitive ordered subsequence of the name; prefix hits rank first, then alignment score, then source order. `Menu.autoFocus` focuses its first enabled item, supports Arrow Up/Down and Home/End navigation, and focuses the first button in the anchor on Escape; it is opt-in for action menus.

### Rendering agent output

`MarkdownText` renders untrusted GFM and TeX math, blocks unsafe links and images, and can turn resolved file mentions into explicit controls. A surrounding `MarkdownDelegateProvider` receives sanitized HTTP(S) URLs from ordinary clicks; modified clicks and links outside a provider retain native external-anchor behavior. When the owner passes a `pathImages` vocabulary, image destinations that are local media paths rewrite to displayable URLs on settled renders only (the same streaming gate as file mentions); without a vocabulary, local destinations remain inert alt text. A load or decode failure replaces the image with its authored alt text, or the original destination when alt is empty. Changing the image source permits a fresh load. While a reply streams, source-only rendering freezes completed blocks, advances a top-level open fence by completed lines, and highlights that fence from saved Shiki grammar state. Completed token lines enter fixed-size React groups, so later chunks reconcile only the growing group; an unchanged fence retains that DOM when the final full parse resolves cross-document syntax. `TerminalBlock`, `ReadBlock`, `DiffBlock`, `SearchBlock`, and `WebBlock` render the matching tool-result intent with copy controls, overflow handling, and ANSI processing where applicable. `JsonTree` and `JsonBlock` inspect JSON values read-only, while `projectUserText` projects sent user text into inline plain runs and reference chips for the message bubble and queue rows. When supplied with `UserTextReferences`, file and skill references become keyboard-accessible preview buttons using the same hover and focus styling as prose file links; the first pointer click can open a preview, while subsequent clicks and existing text selections retain native selection handling. Keyboard activation opens previews even when text is selected.

`CodeBlock` highlights `dot`/`graphviz`, `svg`, and `mermaid` when displaying source, with case-insensitive language hints. These grammars load on demand; mounted source automatically gains theme-token colors when loading completes. SVG shares the XML grammar. Mermaid uses the diagram-body rules from `@shikijs/langs/mermaid`. The pinned DOT grammar and its mechanical conversion are recorded in the [third-party notices](THIRD_PARTY_PREVIEW_NOTICES.txt).

Supply `MarkdownLabels.preview` to show settled `mermaid`, `graphviz`/`dot`, and `svg` fences as previews by default. Supported streaming fences show a 180px image placeholder with a pulsing glyph and localized status; controls become available after streaming ends. Consumers without these labels show source. Mermaid and Graphviz use the active document palette on the code-block background and update mounted previews when resolved colors change. Explicit colors in DOT and SVG remain authored content. Rendering loads Mermaid on demand, uses strict security, and exposes the generated SVG as an image with no diagram link handlers. A render or image-load failure shows the supplied error label with Source available in the toolbar; replacing the source discards late results from the previous render.

`CodeBlock.preview` supplies a standard source-preview descriptor with a renderer and complete localized output and control labels. Callers do not pass React nodes. The language stays on the left; magnifier and copy icons precede the Source/Preview segmented control on the right. Only the selected background slides for 160ms; the body switches immediately. Unsupported blocks show a static selected Source label. Copy always reads source and confirms success through its icon and tooltip without changing toolbar width. Preview shows a magnifier that opens a body-portaled lightbox fitted within 88% of viewport width and 84% of its height. Drag to pan, scroll around the cursor to zoom, or double-click to fit again. Arrow keys pan, +/− zoom, and Home resets. The lightbox reuses the generated image; pending or failed output disables it with a localized accessible explanation. Source replaces the magnifier with a line-number toggle that preserves the source text and copy output. In Preview, the toolbar fades out through opacity alone over 160ms and appears on block hover or keyboard focus; touch devices keep it visible. Source keeps its toolbar visible.

Graphviz loads `@viz-js/viz` on demand and renders DOT with the `dot` engine. SVG and Graphviz output are inert images in the same canvas as Mermaid; malformed SVG and DOT show an error and leave Source available. The browser sizes previews from the image aspect ratio and available width, limiting image height to the smaller of 60vh and 640px. The canvas has 16px padding and a 120px minimum height. Source mounts on first selection, scrolls within that same area, and remains mounted with the generated image across view changes. HTML fences use the ordinary highlighted-code presentation.

[Preview license notices](THIRD_PARTY_PREVIEW_NOTICES.txt) ship with this package and the Web frontend. Mermaid is MIT; Viz.js is MIT but embeds Graphviz under EPL-2.0. The notices retain license texts and the exact Graphviz source download. Dependency upgrades require reviewing the embedded payload as well as npm metadata; the [preview decision](../../../.agents/notes/implemented/feature/2026-09-09-markdown-static-previews.md) records the distribution choices.

`MarkdownText` defaults to `variant="body"`. Use `variant="compact"` for secondary content: its 13px text and 20px line height follow the content-size setting, all heading levels use the same size with weight 600, and paragraphs and lists use tighter spacing. Text, links, and code keep the tertiary color; dotted underlines distinguish links. Code headers scroll with their blocks. Tables and math stay enabled at the surrounding text size and scroll horizontally within the available width. Both variants share the parser and streaming cache.

`DiffBlock` compares the old and new content by line. It shows actual additions and deletions with up to three neutral context lines on each side, separates distant changes with `⋯`, and excludes shared context from both summary and footer totals. Search stops beyond 256 line additions/deletions per fragment; those fragments display and count the complete old and new contents as a coarse replacement, including shared lines. Copy includes the full displayed diff with its prefixes. A final newline is treated as a terminator; differences only in the presence of a final newline are not displayed.

`JsonTree` clamps collapsed strings to `collapsedStringLines` (three by default). Expanded strings show raw text, retain sibling commas, and fit within the window and outer scrolling containers. Resize and ancestor-scroll events update that limit. Row copy feedback updates independently of JSON value rendering; pending clipboard writes cannot update a different row or an unmounted tree.

### Localizing copy

The atoms cannot read the application locale, so every piece of user-facing copy arrives through required label props. `HoverCard`, `TerminalBlock`, `JsonTree`, `CodeBlock`, `MarkdownText`, `JsonBlock`, `ConnectionIndicator`, `Modal`, `DiffBlock`, `ReadBlock`, `SearchBlock`, and `WebBlock` accept complete localized labels. The package owns no language fallback; omission fails typechecking, and each feature maps its typed `t` seat into the primitive's label interface.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package enforces one separation: presentational React atoms with zero Cordis and zero slot knowledge, styled only through `--dsw-*` tokens, while every feature-specific concern (locale, session data, composition) stays in the composing plugin.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Public atom exports |
| [`src/markdown/`](src/markdown/) | Markdown and math pipeline: micromark parsing, KaTeX typesetting, incremental streaming renderer, `CodeBlock`/`JsonBlock` |
| [`src/TerminalBlock.tsx`](src/TerminalBlock.tsx) | ANSI escape parsing (`anser`) and terminal card rendering |
| [`src/ReadBlock.tsx`](src/ReadBlock.tsx) / [`src/DiffBlock.tsx`](src/DiffBlock.tsx) | Read and diff cards |
| [`src/SearchBlock.tsx`](src/SearchBlock.tsx) / [`src/WebBlock.tsx`](src/WebBlock.tsx) | Search and web-retrieval cards |
| [`src/icons/`](src/icons/) | `ic_ds_*` glyph components and brand marks |
| [`src/useAnchoredPosition.ts`](src/useAnchoredPosition.ts) / [`src/useAnchoredMaxHeight.ts`](src/useAnchoredMaxHeight.ts) | Floating-panel and overlay geometry hooks |

### Streaming markdown

While a reply streams, `MarkdownText` parses incrementally: all but the trailing two blocks freeze as cached React elements and only the source tail re-parses per chunk, so per-chunk work tracks the tail instead of the whole reply. A final unclosed top-level fence keeps its parsed code node and sends only the last completed line plus the current partial line through the same GFM grammar; a closing fence or ambiguous parse returns to the ordinary tail path. Highlighting likewise resumes from saved Shiki grammar state and publishes only newly completed lines plus the mutable tail. Re-rendering the same highlight frame reuses its rendered body, so React render retries cannot append completed lines twice. `CodeBlock` seals completed lines into fixed-size React groups, reuses earlier groups, and retains the whole highlighted tree across settlement when code and language are unchanged. The settled full parse still resolves references that crossed the freeze boundary.

### Preview ownership

The streaming placeholder mounts neither the source highlighter nor the diagram renderer. Once streaming ends, the waiting canvas remains until the image loads; stopping a stream also exits the streaming wait. Reduced motion disables its 1.8-second opacity animation. Each mounted block retains its preview across view changes and regenerates for source, renderer, or resolved-theme changes. Previewable blocks mount and highlight source on first selection, then retain its DOM; source-only blocks retain viewport activation. Independent memoized source and copy controls keep toolbar feedback and unchanged parent props from redoing source work, while grammar readiness is specific to the source language. The [interaction decision](../../../.agents/notes/implemented/feature/2026-09-10-codeblock-preview-interaction.md) owns retention, and the [preview sizing decision](../../../.agents/notes/implemented/simplification/2026-09-14-source-sized-code-block-previews.md) owns geometry.

### Geometry and overflow

The output cards share one geometry model: `white-space: pre` with horizontal scrolling so column-aligned content keeps its alignment, and a head-plus-tail slice behind an expand button past `maxLines` (default 16) so a long body never stretches the card. `TerminalBlock` parses ANSI into React spans with a per-line column buffer for cursor movement, honoring erase-in-line, tab stops, and character width.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages place the atoms in the client stack and the design system.

- [ui-renderer](../ui-renderer/README.md) — the React renderer that mounts the assembled application and binds slot data.
- [ui-tool](../ui-tool/README.md) — the tool-call presentation layer that composes these output cards.
- [ui-conversation](../ui-conversation/README.md) — the chat surface that renders markdown replies and tool cards.
- [ui-theme](../ui-theme/README.md) — the `--dsw-*` token system these atoms style through.
- [Web styling](../../../docs/web-styling.md) — the authoritative styling rules for web client components.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define how the atoms behave at the edges; they are current package constraints, not a component roadmap.

- **Diagram rendering runs on the browser thread** — every mounted settled preview starts rendering, including off-screen diagrams. Mermaid serializes layouts; Graphviz performs synchronous WebAssembly layout. Submitted layout work cannot be interrupted. Preview virtualization and worker rendering are not provided.

- **Diff search is bounded, input processing is linear** — the edit-distance limit trades precise alignment for a coarse replacement on heavily changed fragments. Normalization, fallback rows, and copied output still scale with input size; the height cap limits visible rows, not those allocations.
- **Known-site marks are a fixed list** — only the named hosts resolve to their own mark, and every other external host keeps the globe; recognizing an arbitrary site would require fetching its icon over the network.
- **Streaming defers cross-boundary reference resolution** — a reference-style link or footnote whose definition sits on the other side of the incremental freeze boundary renders as literal text while the reply streams; the settled full parse at finalize resolves it.
- **A long highlighted fence retains its complete token DOM** — streaming avoids re-parsing, re-tokenizing, and reconciling the completed prefix, but it does not discard old colors or virtualize token spans. Final DOM cardinality therefore still follows the fence's token count; nested/container fences and a pathological single long line remain on the general tail path.
- **Glyph-level icons are redrawn approximations** — the fish logo and the sparkle mark come from font glyphs whose vector geometry is not exportable from the local design data; hand-authored recreations stand in until an exact export path exists.
- **`Pill` and `Input` have no design source** — both atoms are self-defined; the sidebar search field and view-tab strip that resemble them are consumer-owned compositions, not these atoms.
- **No `Active` `StateDot` variant** — the supported states are done, warning, ongoing, error, and idle.
- **User-facing copy is required at the render site** — the atoms are zero-Cordis and cannot reach `ctx.locale`; each feature must supply complete localized labels through the primitive's typed props ([decision](../../../.agents/notes/implemented/architecture/2026-08-23-locale-owned-client-ui-copy.md)).
- **`TerminalBlock` is not a terminal emulator** — it renders settled or still-running command output, not an interactive session: SGR colors, carriage return, backspace, erase-in-line, tab stops, and character width are honored; absolute cursor positioning, screen clearing, and alternate-screen sequences are stripped.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Pure props-in React atoms with no Cordis API — no events, no services, no mutable cross-plugin state; rendering contracts are asserted directly by this package's component specs.
