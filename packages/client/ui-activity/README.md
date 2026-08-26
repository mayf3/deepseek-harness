---
description: "The session-header task list: background jobs joined per row with their live-output activities, expandable streaming panels, running/finished sections, and the graceful no-registry degradation."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-activity

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-activity` puts this session's running work in one header control: background jobs joined per row with their correlated live-output activities, plus standalone activities such as workflow runs. Expanding an observable row streams its real output into an embedded terminal panel while it runs; collapsing stops the stream, so output only flows while someone is watching. Live rows lead with a ticking duration over a kind-and-status second line, settled rows compact behind a section heading, and without the activity registry the job rows still render — the control degrades to a plain job list rather than disappearing.

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

Load the plugin through the web-app manifest; it renders nothing until the session can see at least one task, so an ordinary conversation never grows a control for a capability it is not using.

### The per-row join

Jobs and activities stay separate planes ([why](../../../.agents/notes/implemented/feature/2026-08-24-activity-observation-seam.md)); the join happens per row in this component. A job row keeps the job's lifecycle, duration, and model-visible `detail` from the `jobsBySession` mirror, and gains an expandable output panel when an activity carries its `correlation.jobId`; an activity without a job keeps its own row. Rows without an observable activity render as static rows with no expansion affordance.

### The expanded panel

Expanding an observable row opens that activity's observation stream from `ctx.activityFeed` into an embedded terminal panel. The panel copies the command (not the output), wraps commands and output lines in full, scrolls its output inside a fixed height instead of folding, and draws no run-state dot of its own — the row above carries the state. Retention gaps and stream failures render as notices above the panel.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One slot entry in the header actions band (after the preset label, before the subagent catalog) renders the trigger and popover; the popover fits itself to the viewport by measuring its anchor. All data arrives through `ctx.activityFeed` and the standard `useSessions` hook — the component holds no transport state. Observation follows visibility: one `useEffect` opens the stream for the expanded row's activity and closes it on collapse, unmount, or popover dismissal.

| File | Role |
|---|---|
| [`src/client/ActivityListAction.tsx`](src/client/ActivityListAction.tsx) | The merged task list: join, sections, durations, panels |
| [`src/client/index.ts`](src/client/index.ts) | Slot registration and the dictionaries |
| [`src/client/locales.ts`](src/client/locales.ts) | The `activity` namespace copy (zh source of truth) |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-api-activity-controller`](../../api/activity-controller/README.md) — the feed service and streams behind the panel.
- [Unified task list Agent Note](../../../.agents/notes/implemented/feature/2026-08-25-unified-task-list.md) — why the join lives in the UI projection.
- [`dsh-client-ui-primitives`](../ui-primitives/README.md) — the `TerminalBlock` surface the panel configures.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package renders host-observed state and live output for a human and touches no prompt, message, schema, stream, or tool result. The model's own view of the same work stays with [`dsh-tool-jobs`](../../jobs/tool-jobs/README.md).

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define current package constraints, not a task backlog.

- **No kill control** — cancellation stays with the model's `job_kill`; a human kill is blocked on the jobs `reported` contract question recorded in the [web job display Agent Note](../../../.agents/notes/implemented/feature/2026-08-08-web-background-job-display.md).
- **Channel labels are not rendered** — stdout and stderr chunks concatenate into one stream; per-channel tinting is a presentation follow-up.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
