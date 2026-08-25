# @deepseek-ai/dsh-client-ui-activity

English | [中文](README.zh.md)

Session-header task list: one header action renders this session's background jobs joined with their correlated live-output activities, plus standalone activities such as workflow runs. The join happens per row in this component — jobs and activities stay separate planes ([why](../../../.agents/notes/implemented/feature/2026-08-24-activity-observation-seam.md)): a job row keeps the job's lifecycle, duration, and model-visible `detail` from the `jobsBySession` mirror, and gains an expandable output panel when an activity carries its `correlation.jobId`; an activity without a job keeps its own row. Live rows lead with the label over a kind-and-status second line and a ticking duration; settled rows compact to one de-emphasized line behind a section divider.

Expanding an observable row opens that activity's observation stream from `ctx.activityFeed` into an embedded terminal panel. Observation follows visibility — the stream opens on expand and closes on collapse, unmount, or popover dismissal, so output only flows while someone is watching. Retention gaps and stream failures render as notices above the panel.

The control renders nothing until the session can see at least one task, so an ordinary conversation never grows a control for a capability it is not using. Without the activity registry, job rows still render from the session mirror — they just offer no output panel.

## Model Experience

None, as this package renders host-observed state and live output for a human and touches no prompt, message, schema, stream, or tool result. The model's own view of the same work stays with [`dsh-tool-jobs`](../../jobs/tool-jobs/README.md).

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

- **No kill control** — cancellation stays with the model's `job_kill`; a human kill is blocked on the jobs `reported` contract question recorded in the [web job display Agent Note](../../../.agents/notes/implemented/feature/2026-08-08-web-background-job-display.md).
- **Channel labels are not rendered** — stdout and stderr chunks concatenate into one stream; per-channel tinting is a presentation follow-up.
