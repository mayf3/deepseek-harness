# Agent Note: Skill Tool row follows the shared font-size axis

Status: implemented
Archived: 2026-09-17

English | [中文](2026-09-17-skill-tool-row-font-axis.zh.md)

## Problem

The collapsed Skill Tool row used fixed 14px text, a 24px row, and a 16px leading slot while ordinary Tool rows used the global secondary font-size tier and content-size delta. Skill therefore rendered larger at the default setting and stopped scaling with the rest of the conversation when the user changed content size.

## Decision

The collapsed Skill row uses `--dsh-content-font-size-secondary` for its title and summary, and applies `--dsh-content-font-delta` to its line height, row height, leading slot, and business glyph. These declarations match the ordinary Tool row and shared `DisclosureRow` summary line. The expanded Instructions card retains its independent header, code font, spacing, and controls.

## Alternatives considered

**Keep the fixed Skill typography.** Rejected because the Skill row is a Tool-call summary peer and should not grow independently from adjacent Tool rows.

**Move the complete Skill row onto `DisclosureRow`.** Rejected for this correction because its existing expanded Instructions layout and interaction are already local; aligning the shared font-size declarations removes the visible mismatch without restructuring the component.

## Testing

The Skill row stylesheet test pins the secondary font-size variable, content delta, collapsed row height, leading-slot size, and glyph size. The authored `skill-tool-row` Web replay changes the global font variables in the shipped composition and checks the computed title, summary, row, and glyph sizes. Existing Skill component tests continue to cover lifecycle, expansion, and durable replay behavior.

## Consequences

The collapsed Skill line now changes size with ordinary Tool rows and remains aligned beside them. The expanded Instructions card does not inherit this change.
