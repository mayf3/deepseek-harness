# Agent Note: Read-only Web Schedule catalog

Status: implemented

English | [中文](2026-08-25-read-only-web-schedule-catalog.zh.md)

## Problem

Schedule already persisted active reminders and delivered due work as ordinary later conversation turns, but a person using Web could not inspect what remained active. The model-facing `schedule_list` tool was not a suitable browser contract: calling it would add a tool transaction, couple UI to Agent availability, and duplicate the Session projection transport already used for durable read models.

The catalog also had to preserve two existing boundaries. A fork must not inherit the parent Session's active reminders even though its event array contains the inherited prefix, and an active-reminder list must not become a second delivery receipt beside the ordinary Assistant response.

## Decision

Schedule registers an optional `schedule` Session projection and a separate browser package renders that complete active value. The durable `schedule/change` stream remains the only authority; the browser performs presentation-only derivation and exposes no mutation.

### Projection boundary

The Schedule unit reuses the domain's strict transition and publishes the complete active `ScheduleRecord[]`; damaged authoritative input fails the existing read/open path, while a malformed disposable checkpoint is rebuilt from the log. The shared [projection state and Client views decision](../architecture/2026-08-19-session-projection-state-and-client-views.md) owns `init(seedLength)`, optional same-key header seeding, checkpoint validation, and the live/cache/history/detached drive paths. This note owns only how the resulting active value is presented in Web.

`@deepseek-ai/dsh-schedule/client` is a type-only browser-safe export of the durable record vocabulary. It does not pull the Cordis plugin, runtime, timers, tools, or Node dependencies into the client graph.

### Web composition and visibility

The shipped Web bundle owns the `@deepseek-ai/dsh-client-ui-schedule` resolution dependency and one `ui-schedule` row with `disabled: true`. The existing Schedule overlay loads `time-context` and the Schedule Host plugin, then enables that row by id. Ordinary Web therefore resolves but never starts the plugin; only an explicit Schedule composition gets both halves.

The header action reads `openState` through the standard Session hook and the `schedule` projection through `useProjection`. It renders only when `openState === 'open'` and the array is non-empty. This gate also hides a prewarmed listing-cache value when opening the current Session fails. A live update that removes the final record closes and unmounts the control.

The slot entry uses internal order 10: static Agent and Subagent information precede it, while the Jobs entry at order 20 follows it. The component owns no shared store; popover visibility is its only local interaction state.

### Sidebar marker

`ui-workspace` owns the ordinary, flat, and search Session rows. It derives one display fact from `SessionSummary.projectionValues.schedule`: a non-empty array renders the same outline alarm after the title, before the ordinary row's update time. The icon is not separately clickable or tabbable; its localized tooltip and screen-reader label say that the Session has an active scheduled task.

Cold rows intentionally inherit projection-cache semantics. An identity-matching usable cached value can show the alarm without opening the Session; a missing or stale cache may cause a brief omission or residue. The marker reports only an undispatched or undeleted durable record known to the list value. It never asserts that a Schedule runtime is live or can wake the Session.

### Presentation and interaction

The 336px popover renders one non-focusable row per active record. The prompt is complete plain text with wrapping and no line clamp; the list scrolls vertically when its content exceeds the existing maximum height. Rows contain no Schedule id, raw UTC, details, or controls.

Each row presents status separately from three metadata fields. After and At are localized as Once. Every chooses the largest day, hour, minute, or second unit that divides the durable `everySeconds` value exactly, so 300 seconds becomes 5 minutes while 301 stays 301 seconds. The browser formats `scheduledAt` in its current locale and time zone and derives relative time from its current clock. These values are not written back to the projection.

Rows sort overdue first, then by ascending `scheduledAt`, then by the projection array index. The final tie-break preserves the Schedule fold's creation order without adding a durable ordering field. Scheduled state uses the business-blue semantic dot; overdue uses the warning-amber semantic dot and row treatment.

The trigger is the catalog's only tab stop. Native button behavior provides Enter and Space activation. Escape closes an open popover and returns focus to the trigger; a pointer press outside closes it. When a projection update removes the last row, the component does not call focus or move it to a neighboring header action.

### Delivery boundary

The catalog is current active state, not history or proof of delivery. A terminal delete or dispatch removes a row. Due work still enters the transcript only through the ordinary Schedule `followup()` and Assistant result. The catalog emits no message, card, toast, acknowledgement, retry affordance, or Schedule-specific error entry.

## Alternatives considered

**Call `schedule_list` from the browser.** This crosses the model-facing tool boundary, requires a live Agent, and creates request and stale-response machinery for data already available through the projection carrier.

**Render raw `schedule/change` events.** Events are persistence protocol, not presentation. A client-side fold would duplicate strict domain logic and expose internal ids and transitions.

**Persist status, relative time, or display order.** These values depend on the viewing browser's clock, locale, and time zone. Persisting them would make replay environment-dependent and introduce unnecessary durable fields.

**Show the control while Session open is failing.** A cached list value may be older than a corrupt tail. Rendering it would present stale partial truth precisely when strict replay rejected the authoritative Session.

**Add row actions or a receipt history.** Mutation belongs to the existing tools, while delivery history belongs to the ordinary transcript. Combining either with this catalog would change its authority and accessibility model.

## Verification

Focused projection and Schedule tests cover strict folding, fork-prefix exclusion, restore, corruption, and registration lifetime. `ui-schedule` tests cover the header catalog's open-state gate, localized formatting, clock-driven status and ordering, wrapping and scrolling, removal, pointer and keyboard behavior, and focus boundaries. `ui-workspace` tests cover grouped, flat, and search marker derivation, placement, localization, accessibility, and row-click behavior. One keyless shipped-Web smoke covers default-disabled versus overlay-enabled composition, a cached marker in ordinary and search rows, the current Session's 900px dark catalog, and one live empty update removing both header and sidebar indicators; the existing conversational scenario continues to cover ordinary Assistant delivery.

## Consequences

- A person can inspect every active reminder without invoking the model or adding another durable source of truth.
- Fork isolation belongs to the shared projection initialization contract rather than a Schedule-specific out-of-band scan.
- Sidebar alarms remain best-effort cache-backed list presentation and never become runtime-liveness indicators.
- Browser time labels may differ across viewers by locale, time zone, and clock while the durable records remain identical.
- Corrupt Schedule history fails the normal Session path and never degrades into a plausible-looking partial catalog.
- The catalog cannot acknowledge, retry, edit, or prove delivery; those semantics remain deliberately outside this surface.
