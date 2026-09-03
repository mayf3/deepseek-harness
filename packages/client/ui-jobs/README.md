---
description: "The session-header background-job list: expandable streaming record panels, running/finished sections, and static rows for jobs without a record."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-jobs

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-jobs` puts this session's background jobs in one header control. Every row carries the job's lifecycle, ticking duration, and model-visible `detail` from the `jobsBySession` mirror; a job that declared an observation record additionally offers an expandable panel that streams its real output while it runs. Collapsing stops the stream, so output only flows while someone is watching. Live rows lead with a ticking duration over a kind-and-status second line; settled rows compact behind a section heading; jobs without a record (subagent delegations, PTY sends) render as static rows with no expansion affordance.

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

Load the plugin through the web-app manifest; it renders nothing until the session can see at least one job, so an ordinary conversation never grows a control for a capability it is not using.

### One row per job

The session control stream's `jobsBySession` mirror is the single roster: each `SessionJob` row carries lifecycle, duration, and the model-visible `detail`, and its `record` flag is present exactly when the job declared a record — that flag is what makes a row expandable. There is no second roster to join.

Running job rows also carry a two-press stop control: the first press arms it, the confirming press within three seconds calls `ctx.jobOutput.kill`, and the row converges through the jobs frames (`stopping`, then the settled section). The kill leaves the terminal report unclaimed, so the owning agent still receives the standard completion notice — the model is told the user stopped its task rather than left to infer it ([decision](../../../.agents/notes/implemented/feature/2026-08-26-human-job-kill.md)).

### The expanded panel

Expanding an observable row opens that job's record observation stream from `ctx.jobOutput` (installed by `dsh-api-job-controller`) into an embedded terminal panel. The panel copies the command (not the output), wraps commands and output lines in full, scrolls its output inside a fixed height instead of folding, and draws no run-state dot of its own — the row above carries the state. Retention gaps and stream failures render as notices above the panel.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One slot entry in the header actions band (after the preset label, before the subagent catalog) renders the trigger and popover; the popover fits itself to the viewport by measuring its anchor. All data arrives through `ctx.jobOutput` and the standard `useSessions` hook — the component holds no transport state. Observation follows visibility: one `useEffect` opens the stream for the expanded row's job and closes it on collapse, unmount, or popover dismissal.

| File | Role |
|---|---|
| [`src/client/JobListAction.tsx`](src/client/JobListAction.tsx) | The job list: sections, durations, panels |
| [`src/client/index.ts`](src/client/index.ts) | Slot registration and the dictionaries |
| [`src/client/locales.ts`](src/client/locales.ts) | The `job` namespace copy (zh source of truth) |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-api-job-controller`](../../api/job-controller/README.md) — the `job.observe` stream, the `job.kill` Remote, and the `ctx.jobOutput` service behind the panel and the stop control.
- [`dsh-api-session-controller`](../../api/session-controller/README.md) — the `jobsBySession` roster mirror the rows come from.
- [`dsh-jobs`](../../jobs/jobs/README.md) — the registry contract that owns the record semantics.
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

- **Channel labels are not rendered** — stdout and stderr chunks concatenate into one stream; per-channel tinting is a presentation follow-up.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. This package is a read-only projection of the `jobsBySession` mirror onto one header slot entry. It emits no cordis events, owns no cross-plugin mutable state, and its single slot registration proves disposal through the HMR-safety spec.
