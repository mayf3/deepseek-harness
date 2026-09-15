# Agent Note: An open menu takes the first Escape from its dialog

Status: implemented

English | [中文](2026-09-15-overlay-escape-layering.zh.md)

## Problem

`Modal` and `Menu` each close on Escape through their own document-level keydown listener. A menu open inside a dialog is therefore closed by the same keystroke that closes the dialog: one Escape discards two layers of the user's context and leaves the keyboard wherever it was before the dialog opened. Every settings row, the workspace browser, and the terminal body render a menu inside a dialog.

## Decision

The dialog yields the first Escape to an open menu. `Modal`'s keydown listener returns while `document.querySelector('[role="menu"]')` matches, so the menu's own handler closes the menu and returns the keyboard to its anchor; the next Escape reaches the dialog. Menus that render no `[role="menu"]` — the composer's trigger menu and popup select panel are listboxes — keep their own layering and are unaffected.

## Alternatives considered

**Order the two listeners.** Both sit on `document`, so which runs first is registration order: a dialog mounts before the menu it opens, so the dialog always wins. Making that order carry the rule would be fragile.

**Track an overlay stack in a service.** Two nested layers in one place do not justify the machinery, and nothing else needs the ordering.

**Let one Escape close both.** It is the behavior this decision removes: a single keystroke must not discard both the menu and the dialog the user opened it from.

## Verification

[Dialog tests](../../../../packages/client/ui-primitives/tests/atoms.client.spec.tsx) render a `Menu` inside an open `Modal`: the first Escape closes the menu and leaves the dialog standing with the keyboard on the menu's anchor, and the second Escape reaches the dialog.

## Consequences

Escape now walks the overlay layers one at a time: menu, then dialog. The dialog's own Escape keeps closing it directly when no menu is open inside it, and a menu that is not a `[role="menu"]` never intercepts the dialog's Escape.
