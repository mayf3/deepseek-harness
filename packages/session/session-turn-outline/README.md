---
description: "Whole-log turn outline for clients and maintainers composing or debugging the turnOutline projection unit behind full-session turn navigation."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-turn-outline

English | [中文](README.zh.md)

## Summary

`dsh-session-turn-outline` serves the whole-log turn outline — every started turn with its `turn/start` seq and a bounded first-prompt preview — as the `turnOutline` projection unit. A client that pages history in windows reads the outline to offer every turn of the session (loaded or not) and to target its backwards paging at the exact seq that brings a turn's events in. Choose it in compositions that already mount the projection registry, such as the web app bundle whose chat turn rail is the reference consumer; assemblies without the registry are unaffected and their consumers fall back to loaded-window navigation. Setup and entry semantics come first; the fold internals live in a collapsible developer section below.

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

Mount the plugin beside the session store and the projection registry when clients should navigate every turn of a session without holding its complete event log. The unit registers only when the registry is present.

### Composition

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-projection'
- name: '@deepseek-ai/dsh-session-turn-outline'
```

### What an entry means

| Field | Meaning |
|---|---|
| `turn` | Host-assigned turn number from the `turn/start` payload |
| `seq` | The turn's `turn/start` event seq — paging a window back through this seq loads the whole turn |
| `prompt` | Preview of the turn's first human prompt (space-joined text blocks, collapsed whitespace, 160-character cap); `''` until an eligible prompt lands |

Entries are strictly increasing by `turn`, and the wire value is the complete outline (whole-value rule): consumers replace, never merge. Only `user/message` events with the human `user` source fill previews, so injected context and tool results never leak into navigation; a turn whose prompt is images-only keeps `''` and consumers label it by number. The preview budget matches the chat rail's loaded-turn preview, so a turn shows the same words before and after its events load.

### Failures and recovery

The unit is inert without the projection registry: `inject` keeps the fiber pending and nothing registers, so other assemblies lack the `turnOutline` key. Unmounting the plugin removes the key, because registrations are effects on the mounting fiber. Persisted-cache rows are schema-validated on restore — including the strictly-increasing turn order — so a corrupt row is discarded instead of seeding a broken fold.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the fold behind the outline; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The unit is a pure fold over committed session events. `turn/start` — not the prompt `user/message` — anchors each entry because its seq is the load-through target for a jump: the agent loop logs `turn/start` before the turn's prompt and steps, so a window paged back through that seq contains the whole turn. The preview then fills from the first human `user/message`, and only while the newest entry is still empty — later human messages in the same turn (steering) keep the first preview.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `inject`, unit registration on the mounting fiber |
| [`src/projection.ts`](src/projection.ts) | The fold: entry append, preview fill, wire view |
| [`src/types.ts`](src/types.ts) | One home of the `turnOutline` projection-key declaration and entry types |

### Fold rules

- Uninteresting events return the same state reference; the registry's `Object.is` gate keeps the change feed quiet — the outline moves at most twice per turn.
- A `turn/start` that does not advance the turn number is skipped, keeping the outline sorted; a retried boundary's prompt then lands on the standing entry.
- State and wire view are the same value, so the persisted-cache state schema is the wire schema.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the unit's contract is not enough. They move from the registry that drives units to adjacent session packages.

- [Session projection subsystem](../../../docs/subsystems/session-projection.md) — the registry that drives units and serves snapshot and change-feed values.
- [Session projection registry package](../session-projection/README.md) — the registry contract units register against.
- [Session package map](../README.md) — adjacent persistence, projection, title, and telemetry packages.

-----

<a id="model-experience"></a>
## Model Experience

None, as the turnOutline unit folds already-logged turn boundaries into a client-facing read model and registers nothing model-facing.

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the outline describes and when the unit is absent. They are current package constraints.

- **The wire value grows with the session** — every change pushes the complete outline (whole-value rule), roughly 200 bytes per turn; splitting previews into an on-demand read is deferred until sessions with many thousands of turns need it.
- **Previews carry the prompt only** — assistant-response previews stay window-scoped in the consumer; the outline never re-reads message bodies.
- **A turn without an eligible text prompt keeps `''`** — images-only and command-only turns are navigable but labeled by number.
- **Mounted only where the projection registry is composed** — other assemblies serve no `turnOutline` key, and their consumers fall back to loaded-window navigation.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
