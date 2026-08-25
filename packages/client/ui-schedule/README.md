# @deepseek-ai/dsh-client-ui-schedule

English | [中文](README.zh.md)

Read-only Web catalog for the current Session's active Schedule records. The plugin contributes one `conversation.session.header.actions` entry after the static Agent and Subagent context and before the background Jobs entry. It reads `openState` through the standard Session hook and the complete `schedule` value through `useProjection`; it issues no RPC and receives no mutation callback.

The trigger exists only while the Session is successfully open and the projection contains at least one record. Its popover is 336px wide, scrolls vertically when needed, and shows each prompt as complete wrapping plain text. Every row renders status separately from three metadata fields: localized Once or the largest exact whole unit for an Every interval, browser-local target time, and browser-clock-relative time. Intervals are never rounded. Overdue records sort first, followed by `scheduledAt`; exact ties preserve the projection's creation order.

Only the native button is in the tab order. Enter and Space use its normal button activation, Escape closes the popover and restores trigger focus, and an outside pointer press dismisses it. If a live projection update removes the final record, the component closes and unmounts without moving focus to another header action.

This catalog is not a delivery receipt. It exposes no Schedule id, raw UTC value, details, mutation, retry, toast, or Schedule-specific transcript card. Due reminders still arrive only as ordinary Assistant conversation output, and a failed Session open hides even a previously cached catalog value.

The behavior and ownership boundary are recorded in the [read-only Web Schedule catalog Agent Note](../../../.agents/notes/implemented/feature/2026-08-25-read-only-web-schedule-catalog.md).

## Model Experience

None, as this package renders a completed client projection for a human and never changes prompts, messages, schemas, streams, or tool results.

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

- **Active records only** — terminal delete and dispatch transitions remove rows; the ordinary transcript remains the only reminder-delivery history.
- **Browser-derived time** — local and relative labels use the viewing browser's current locale, time zone, and clock. They are presentation values, not durable Schedule facts.
- **Read-only surface** — creating, deleting, and inspecting model-facing delivery state remain with the Schedule tools; this package deliberately has no action controls.
