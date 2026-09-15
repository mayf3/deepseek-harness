# Agent Note: Composer paste inserts line breaks

Status: implemented

English | [中文](2026-09-15-composer-paste-line-breaks.zh.md)

## Problem

A pasted multi-line draft and a typed one hold the same text in different documents. The composer's paste path inserted clipboard text through `RangeSelection.insertText`, which keeps every newline inside one text node, while typing and the editor's own programmatic writes produce a line-break node per line.

Inside a single text node the browser reports the collapsed caret's geometry as the block's. With a pasted draft scrolled to its end, deleting the trailing line made Lexical's collapsed-caret reveal — `scrollIntoViewIfNeeded`, reached from `$updateDOMSelection` — read a zero-height rect at the top of the block and write that offset into the composer's scrollport. The capped box then showed the head of the draft with the caret off screen, in a draft that still overflowed. The same document also gave Home and vertical caret movement block boundaries instead of line boundaries.

## Decision

[`DraftEditorRuntime.paste()`](../../../../packages/client/ui-conversation/src/client/input/editor/runtime.ts) inserts through `RangeSelection.insertRawText`, the path Lexical's own paste handler uses; its raw-text generator splits the input into text and line-break nodes. A pasted draft therefore carries the document a typed draft carries, and both project to the same draft text.

## Alternatives considered

**Keep `insertText` and correct the reveal in the composer view.** The composer's own `revealDraftSelection` never ran during the failing gesture: the write came from Lexical's selection reconciliation, which owns the caret reveal for a collapsed selection. Guarding that function would not have reached it, and suppressing Lexical's reveal would remove the caret tracking ordinary typing depends on.

**Rewrite newlines inside the pasted text.** Normalizing the clipboard text before insertion leaves the document unchanged — the defect is the node structure the insertion produces, not the characters it receives.

## Consequences

Pasted newlines become line-break nodes instead of characters inside a text node. The clipboard projection, and with it the submitted prompt, the draft mirror, and trigger spans, is unchanged: `$composerLayout` projects a line-break node and a paragraph gap alike as one `\n`. Tab characters reach `TabNode` through the same raw-text path. The composer no longer relies on the browser reporting per-line geometry for a draft stored in one text node.

## Testing

[The composer scroll scenario](../../../../apps/web/tests/composer-draft-scroll.e2e.ts) pins the behavior in a real browser: a pasted draft with a blank tail, scrolled to its end, holds `scrollTop === scrollMax` through an end-of-draft Backspace and through a selection delete of the trailing lines. Reverting `paste()` to `insertText` fails that case on `scrollTop === scrollMax` while the draft still overflows; the scenario's typed-draft cases and its committed geometry golden pass with either insertion path.
