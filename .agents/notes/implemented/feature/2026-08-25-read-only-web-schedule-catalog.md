# Agent Note: Read-only Web Schedule catalog

Status: implemented

English | [中文](2026-08-25-read-only-web-schedule-catalog.zh.md)

## Problem

Schedule already persisted active reminders and delivered due work as ordinary later conversation turns, but a person using Web could not inspect what remained active. The model-facing `schedule_list` tool was not a suitable browser contract: calling it would add a tool transaction, couple UI to Agent availability, and duplicate the Session projection transport already used for durable read models.

The catalog also had to preserve two existing boundaries. A fork must not inherit the parent Session's active reminders even though its event array contains the inherited prefix, and an active-reminder list must not become a second delivery receipt beside the ordinary Assistant response.

## Decision

Schedule registers an optional `schedule` Session projection and a separate browser package renders that complete active value. The durable `schedule/change` stream remains the only authority; the browser performs presentation-only derivation and exposes no mutation.

### Seed-aware strict projection

`ProjectionDefinition.init()` receives the immutable `SessionHeader`. Live lazy builds, event-driven builds, persisted-cache restores, Session history reads, and detached Subagent reads use the same header that supplied their events, and the registry rejects a `seedLength` beyond the observed log. Existing units may ignore the input. A fork-sensitive unit can retain `header.seedLength ?? 0` in state and skip every event whose `seq` is below the boundary without consulting an ambient Session object.

The Schedule unit persists `{ seedLength, active, seenIds }`, reuses the domain's strict decoder and `applyScheduleChange` transition, and publishes the complete active `ScheduleRecord[]`. Keeping `seenIds` preserves the no-reuse invariant after cached restore. Its strict state schema rejects malformed records, duplicate ids, and active ids absent from the used-id set. A damaged authoritative event fails the existing read/open path; a malformed non-authoritative checkpoint is discarded and rebuilt from the log. No partial array is published.

`@deepseek-ai/dsh-schedule/client` is a type-only browser-safe export of the durable record vocabulary. It does not pull the Cordis plugin, runtime, timers, tools, or Node dependencies into the client graph.

### Web composition and visibility

The shipped Web bundle owns the `@deepseek-ai/dsh-client-ui-schedule` resolution dependency and one `ui-schedule` row with `disabled: true`. The existing Schedule overlay loads `time-context` and the Schedule Host plugin, then enables that row by id. Ordinary Web therefore resolves but never starts the plugin; only an explicit Schedule composition gets both halves.

The header action reads `openState` through the standard Session hook and the `schedule` projection through `useProjection`. It renders only when `openState === 'open'` and the array is non-empty. This gate also hides a prewarmed listing-cache value when opening the current Session fails. A live update that removes the final record closes and unmounts the control.

The slot entry uses internal order 10: static Agent and Subagent information precede it, while the Jobs entry at order 20 follows it. The component owns no shared store; popover visibility is its only local interaction state.

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

Projection tests cover shared transition equivalence, creation order, fork-prefix exclusion, checkpoint restore, strict corruption propagation, and registration teardown. Registry, cache, history, and Subagent tests cover immutable-header initialization and seed-bound validation on live, lazy, full-log, and detached paths. Browser tests cover capability absence, open-state gating, English and Chinese copy, exact interval units, local and relative time, clock crossing, status and stable sorting, complete plain-text prompts, scrolling, live removal, outside dismissal, keyboard activation, Escape focus return, and no focus migration on external unmount. The keyless shipped-Web scenario covers default-disabled versus overlay-enabled composition, live changes, reload and cold baseline, fork isolation, ordinary Assistant delivery, header ordering, and narrow dark layout.

## Consequences

- A person can inspect every active reminder without invoking the model or adding another durable source of truth.
- Fork isolation belongs to the shared projection header input rather than a Schedule-specific out-of-band scan.
- Browser time labels may differ across viewers by locale, time zone, and clock while the durable records remain identical.
- Corrupt Schedule history fails the normal Session path and never degrades into a plausible-looking partial catalog.
- The catalog cannot acknowledge, retry, edit, or prove delivery; those semantics remain deliberately outside this surface.
