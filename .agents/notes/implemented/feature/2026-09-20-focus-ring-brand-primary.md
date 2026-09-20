# Agent Note: One keyboard-focus colour for every control

Status: implemented

English | [中文](2026-09-20-focus-ring-brand-primary.zh.md)

## Problem

Keyboard focus rings carried at least five different colours across the client: `--dsw-alias-state-business-primary` on 31 declarations, `--dsw-alias-label-primary`, `--dsw-alias-label-tertiary`, `--dsw-alias-state-warn-label`, `--dsw-alias-border-l4` and two button fills elsewhere. Controls that declared no ring at all fell back to the browser default, whose colour follows the operating-system accent — so the same build shows orange on one machine and blue on another, and a control can change colour when nothing about the control changed.

## Decision

Every keyboard focus ring uses `--dsw-alias-brand-primary`.

Two parts implement this, and both are required. `ui-theme/src/styles/focus.css` declares a global `:focus-visible { outline-color: var(--dsw-alias-brand-primary) }`, which reaches the controls that draw the browser default. The 49 component declarations that named another colour now name the same token. Only the colour changed: each declaration keeps its own width, style and offset.

The global sheet sets `outline-color` alone. A component that owns a focus ring keeps it, because its `.class:focus-visible` selector outweighs the bare `:focus-visible` rule; a control with no ring of its own inherits the brand colour instead of the system accent.

## Alternatives considered

**Only rewrite the component declarations.** The 49 explicit rings would agree, but every control that relies on the browser default — the sidebar rail toggles among them — would still paint the operating-system accent, which is the visible symptom this change exists to remove.

**Give each remaining control its own ring declaration.** This reaches the same result, but each new control reintroduces the defect until someone remembers to add a ring, and the shell styles would have to anticipate every interactive element it renders.

**Unify width and offset as well.** The reported inconsistency included those, but the confirmed design decision covers colour. Width and offset stay per component until a design decision fixes them.

**Replace every `outline: none` declaration with the shared ring.** Those declarations accompany deliberate alternatives (inset `box-shadow` rings, container-level focus treatment) or suppress focus on containers that must not show one. Removing them changes behaviour beyond colour.

## Consequences

The focus colour no longer tracks the operating-system accent, so a screen recording or screenshot is reproducible across machines. Components keep their geometry, and controls that never declared a ring now match those that did. The global rule is the only place that decides the fallback, so a future design change edits one token reference rather than every module.

`ui-theme/tests/client-styles.client.spec.ts` pins the sheet in the injection order. `pnpm run test:gui` covers the client suites; the recorded Web replay covers the assembled browser.
