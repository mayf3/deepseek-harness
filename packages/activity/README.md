---
description: "The activity package group: the non-consuming live-output observation plane under packages/activity/, for readers choosing or navigating the family."
kind: "package-group"
---

# activity/ — streaming-output observation family

English | [中文](README.zh.md)

## Summary

This family lets any number of independent observers watch a long-running producer's live output without touching the model-facing paths: an activity is an append-only bounded output stream plus live status, read at absolute byte offsets that survive eviction. `activity` defines the registry contract and vocabulary; `activity-local` implements the in-memory ring-buffer registry. The plane is optional and invisible to the model — a composition without it loses only live observation.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

The Service Definition and its local implementation:

| Package | Role | ctx key |
|---|---|---|
| [`activity/`](activity/README.md) | Defines the observation registry and vocabulary | `ctx.activities` |
| [`activity-local/`](activity-local/README.md) | Implements the in-memory ring-buffer registry | registers on `ctx.activities` |

<a id="related-documentation"></a>
## Related documentation

- [`dsh-api-activity-controller`](../api/activity-controller/README.md) — the Web transport and client model over this plane.
- [`dsh-client-ui-activity`](../client/ui-activity/README.md) — the session-header task list rendering it.
- [docs/subsystems/activity.md](../../docs/subsystems/activity.md) — the subsystem reference: offsets, retention, listener delivery.
- [Activity observation seam Agent Note](../../.agents/notes/implemented/feature/2026-08-24-activity-observation-seam.md) — the design decision; background bash/pwsh and the workflow tool are the shipped producers.

<a id="dev-note"></a>
## Dev Note

None.
