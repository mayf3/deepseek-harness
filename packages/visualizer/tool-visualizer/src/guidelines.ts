/** Progressive visual guidance categories exposed to the model. */
export const WIDGET_GUIDELINE_MODULES = [
  'diagram', 'mockup', 'interactive', 'chart', 'illustration',
] as const

/** One progressive visual guidance category exposed to the model. */
export type WidgetGuidelineModule = (typeof WIDGET_GUIDELINE_MODULES)[number]

const DELIVERY_GUIDANCE = `## Delivery
- Call show_widget next with the complete source; keep planning brief.`

const FOUNDATION_GUIDANCE = `## Foundation
- Theme variables available: --dsw-alias-bg-base, --dsw-alias-bg-layer-1, --dsw-alias-bg-layer-2, --dsw-alias-border-l1, --dsw-alias-border-l2, --dsw-alias-brand-primary, --dsw-alias-button-primary-fill, --dsw-alias-interactive-bg-hover, --dsw-alias-interactive-bg-active, --dsw-alias-label-primary, --dsw-alias-label-primary-inverted, --dsw-alias-label-secondary, --dsw-alias-label-tertiary, --dsw-alias-state-error-primary.
- Use readable controls and a visual surface suited to the subject; avoid wrapping the result in an extra outer frame or giving every item its own panel.
- Center the task's primary result or relationship; leave secondary explanation to the reply.
- For a broad request, choose one representative scenario and leave alternatives to the reply.
- Keep related inputs and primary results in one compact flow; reserve separate panels for distinct tasks.
- Keep labels in the user's language.
- Keep content inside its coordinate space or normal document flow. At narrow widths, reflow controls, legends, comparison layouts, and exact-value rows instead of clipping, shrinking labels, or adding nested scrolling; let flexible grid and flex children shrink with min-width: 0.
- Pair color with a label, shape, or pattern.
- Give every primary visual a concise accessible name and summary.`

const GUIDELINES: Readonly<Record<WidgetGuidelineModule, string>> = Object.freeze({
  diagram: `## Diagram
- When using raw SVG for a diagram, begin the source with <svg>, put any styles inside it, and give it one responsive viewBox that fills the available width; do not assume a fixed card width.
- Match layout to the relationship: use one reading direction for sequences, a cycle only when recurrence is the point, a staged state view when stages need inspection, shallow nested regions for containment, and simplified forms with outside labels for spatial structure. Keep connectors behind nodes, avoid crossings, and label relationships directly.
- Keep node text to labels and short phrases; move sentence-level explanation to the reply. Fit labels by widening or wrapping nodes. If the relationships still cannot fit at a readable size, split the visual into overview and detail views instead of shrinking text. Use semantic groups, consistent radii and spacing, and a visible hierarchy before decoration. If geometry is illustrative rather than sourced, label it as schematic or not to scale. Do not use emoji as decoration.`,
  mockup: `## Mockup
- Show only the product surface needed to explain the interaction; this is an explanatory mockup, not a full application shell.
- Keep controls clearly labelled and state changes unambiguous; use accessible native controls when interaction is required.
- Make simulated content and actions unmistakably non-live.`,
  interactive: `## Interactive
- Keep the task's primary interaction or result dominant.
- Match each input to its semantics with one primary control per value: fields for exact entry, choice controls for discrete values, and ranges only for values meant to be swept. Give every control a clear label. Native controls come styled, focusable, and keyboard-accessible; custom controls must match that.
- Within an HTML fragment, use inspectable DOM or inline SVG elements when they can represent the scene directly; use canvas only when retaining one element per visual mark would be impractical.
- Keep self-contained interactions and computation local; they must not call the model.
- Use motion when change over time materially contributes to the meaning or experience. Motion may start immediately when it is central to the result; otherwise begin stable and let continuous motion follow a user action. Honor reduced-motion preferences.
- Reuse a bounded set of DOM or SVG nodes for recurring updates; change textContent or attributes in place instead of rebuilding markup, and stop scheduling while idle, paused, or settled.
- Keep changing numeric readouts from shifting the layout by using tabular numerals and reserving enough width for expected values.
- Call window.dshWidget.sendPrompt(text, event) directly from a trusted click or keydown handler, at most once per event, and only when the next step genuinely needs the model. The message enters the conversation immediately, labelled as widget-authored; there is no confirmation step.
- Recover from non-fatal errors. Keep behavior deterministic; when variation is meaningful, make it reproducible and resettable.`,
  chart: `## Chart
- Choose the smallest chart that exposes the relationship: bars for comparison, lines for ordered change, dots for distribution, and tables when exact lookup matters most.
- Start quantitative axes at zero when magnitude comparison depends on it; otherwise mark the scale and domain clearly. When a wide magnitude range hides structure, consider a clearly labelled log scale, normalized view, or small multiples only when it preserves the comparison's meaning.
- Leave room so marks, ticks, and labels do not overlap or clip. Include units, preserve meaningful precision, distinguish missing values from zero, format signs consistently, and use a legend when direct labels would collide.
- Keep series count small and include the main finding in the accessible summary. When series become visually indistinguishable, use a consolidated or direct-difference view if separate marks no longer carry meaning.`,
  illustration: `## Illustration
- Use illustration only when its visual form carries information that prose does not.
- Derive the visual language from the subject and requested tone, with one clear focal point.
- An illustration may be still or animated. Combine it with Interactive when motion or manipulation contributes to the presentation.
- Use canvas for dense or procedurally repeated imagery; use raw SVG when a modest set of inspectable shapes is enough.`,
})

/**
 * Compose requested modules once each, preserving caller order.
 * @param modules - Visual guidance categories requested by the model.
 * @param includeDelivery - Whether the caller can use the delivery tool.
 * @returns The selected guidance sections joined in caller order.
 */
export function composeGuidelines(
  modules: readonly WidgetGuidelineModule[],
  includeDelivery: boolean,
): string {
  const selected = [...new Set(modules)].map(module => GUIDELINES[module])
  return [includeDelivery ? DELIVERY_GUIDANCE : undefined, FOUNDATION_GUIDANCE, ...selected]
    .filter(section => section !== undefined)
    .join('\n\n')
}
