---
description: "The in-memory activity registry: configurable ring-buffer retention (retainBytes, settledRetainBytes), absolute offsets across eviction, owner-scoped cleanup, and layered listener delivery for live-output observation."
kind: "package-reference"
---

# @deepseek-ai/dsh-activity-local

English | [中文](README.zh.md)

## Summary

`dsh-activity-local` makes `ctx.activities` real: mount its one row and every producer's live output is retained in a bounded in-process ring readers address by absolute byte offsets, with fresh snapshots and chunk copies handed out — never live state. Retention is configurable per deployment, records outlive their producer fibers, and owner disposal cleans up exactly the disposed session's rows. Choose it for the single-Host web deployment this repository ships; durable or cross-process observation needs a different provider.

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

Mount one `cordis.yml` row (`name: '@deepseek-ai/dsh-activity-local'`) beside `dsh-agent`; producers and consumers then reach the registry as `ctx.activities`.

### Retention

Each activity retains a chunk ring whose offsets stay absolute across eviction: dropping the head advances `outputEarliest`, and a single chunk larger than the live cap keeps only its UTF-8-safe tail with a `gapBefore` marker. Settlement trims the ring to the settled cap so a finished activity still shows its tail without holding the live budget.

| Config | Default | Meaning |
|---|---|---|
| `retainBytes` | `262144` | Live output retention per activity, in UTF-8 bytes. |
| `settledRetainBytes` | `16384` | Retention kept after an activity settles. |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-activity-local) is the exhaustive source for every accepted field.

### Lifecycle

Records outlive producer fibers. The first activity for an owner attaches one cleanup to the exact `Agent` scope; owner disposal ends still-open records (`killed`, `owner disposed`) and removes them, announcing the removal. Service disposal ends everything, clears the store, and announces each emptied owner. Neither awaits a producer — the registry owns no execution resource.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One process-wide `LocalActivityRegistry` keeps a map of tracked records, each holding its chunk ring and cursor facts. Listeners are layered by registration scope exactly like the jobs registry, so delivery stays owner-relative in one instance, and every listener is contained. Trimming walks whole chunks and only tail-cuts a single oversized chunk on a UTF-8 boundary.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The registry: rings, retention, fencing, scoped listener layers, disposal |
| [`src/invariant.ts`](src/invariant.ts) | Package invariant companion |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-activity`](../activity/README.md) — the contract this provider implements.
- [docs/subsystems/activity.md](../../../docs/subsystems/activity.md) — offsets, retention, and delivery in one reference.
- [`dsh-api-activity-controller`](../../api/activity-controller/README.md) — the Remote streams reading this registry.

-----

<a id="model-experience"></a>
## Model Experience

None, as the provider stores and serves observation state only; the producers own every model-visible surface.

#### KV Cache effect

None; the package never assembles or alters provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the provider is a poor fit. They are current package constraints, not a task backlog.

- **The unowned bucket has no admission bound** — owned producers are already bounded by the jobs admission policy, but a plugin opening many unowned activities grows the store until service disposal.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
