# @deepseek-ai/dsh-activity-local

English | [中文](README.zh.md)

The in-memory Service Provider for the [`dsh-activity`](../activity/README.md) observation seam: `LocalActivityRegistry` keeps every record and its bounded output ring in process memory and hands out fresh snapshots and chunk copies, never live state.

## Retention

Each activity retains a chunk ring whose offsets stay absolute across eviction: dropping the head advances `outputEarliest`, and a single chunk larger than the live cap keeps only its UTF-8-safe tail with a `gapBefore` marker. Settlement trims the ring to the settled cap so a finished activity still shows its tail without holding the live budget.

| Config | Default | Meaning |
|---|---|---|
| `retainBytes` | `262144` | Live output retention per activity, in UTF-8 bytes. |
| `settledRetainBytes` | `16384` | Retention kept after an activity settles. |

## Lifecycle

Records outlive producer fibers. The first activity for an owner attaches one cleanup to the exact `Agent` scope; owner disposal ends still-open records (`killed`, `owner disposed`) and removes them, announcing the removal. Service disposal ends everything, clears the store, and announces each emptied owner. Neither awaits a producer — the registry owns no execution resource. Listeners are layered by registration scope exactly like the jobs registry, so delivery stays owner-relative in one process-wide instance.

## Model Experience

None, as the provider stores and serves observation state only; the producers own every model-visible surface.

#### KV Cache effect

None; the package never assembles or alters provider requests.

## Known Limitations and Deferred Work

- **The unowned bucket has no admission bound** — owned producers are already bounded by the jobs admission policy, but a plugin opening many unowned activities grows the store until service disposal.
