# @deepseek-ai/dsh-client-ui-activity

English | [中文](README.zh.md)

Session-header live-activity list over `ctx.activityFeed`: one header action beside the background-job list renders the roster rows this session can see (owned plus unowned), and expanding a row opens that activity's observation stream into an embedded terminal panel. Observation follows visibility — the stream opens on expand and closes on collapse, unmount, or popover dismissal, so output only flows while someone is watching. Retention gaps and stream failures render as notices above the panel.

The control renders nothing until the session can see at least one activity, so an ordinary conversation never grows a control for a capability it is not using; without the activity registry the roster stays empty and the entry point never appears.

## Model Experience

None, as this package renders host-observed live output for a human and touches no prompt, message, schema, stream, or tool result. The model's own view of the same work stays with [`dsh-tool-jobs`](../../jobs/tool-jobs/README.md).

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

- **No kill control** — cancellation stays with the model's `job_kill`; a human kill is blocked on the jobs `reported` contract question recorded in the [web job display Agent Note](../../../.agents/notes/implemented/feature/2026-08-08-web-background-job-display.md).
- **Channel labels are not rendered** — stdout and stderr chunks concatenate into one stream; per-channel tinting is a presentation follow-up.
- **A background job appears in both header lists** — the job list carries control-facing status, this list carries output; the duplication mirrors the deliberate subagent-catalog precedent.
