# activity/ — streaming-output observation family

English | [中文](README.zh.md)

This family gives every long-running producer one non-consuming observation plane: an activity is an append-only bounded output stream plus live status, readable by any number of independent observers at absolute byte offsets while the model-facing paths (`ctx.jobs` cursors, tool results) stay untouched.

| Package | Role | ctx key |
|---|---|---|
| [`activity/`](activity/README.md) | Defines the observation registry and vocabulary | `ctx.activities` |
| [`activity-local/`](activity-local/README.md) | Implements the in-memory ring-buffer registry | registers on `ctx.activities` |

The Web transport and client consumers live in [`dsh-api-activity-controller`](../api/activity-controller/README.md) and [`dsh-client-ui-activity`](../client/ui-activity/README.md); background bash/pwsh and the workflow tool are the shipped producers.

The subsystem reference — offsets, retention, listener delivery — is [docs/subsystems/activity.md](../../docs/subsystems/activity.md); design in the [activity observation seam](../../.agents/notes/implemented/feature/2026-08-24-activity-observation-seam.md) Agent Note.
