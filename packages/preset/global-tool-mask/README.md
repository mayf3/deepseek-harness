---
description: "Composition-authored global-tool mask for one agent preset: a row that hides named host tools from the sessions the preset composes."
kind: "package-reference"
---

# @deepseek-ai/dsh-global-tool-mask

English | [中文](README.zh.md)

## Summary

`dsh-global-tool-mask` is `tools.restrict()` as a composition row. The host's global tools — the ones a host row registers, such as `web_fetch` — reach every session through the global layer, and nothing in a preset file could hide one until now: a preset can add rows, not subtract tools other rows registered. Mounted inside an agent preset, this row masks the named global tools for the sessions that preset composes and nothing else; mounted globally it rejects, because a context-global restriction would mask every agent. Its intended home is a preset's user patch layer (`$DSH_HOME/.agent-presets/<id>/cordis.patch.yml`), where a person hides a host tool from one preset without editing the composition the deployment ships.

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

Insert one row into a preset's composition or its user patch layer. `deny` hides the named tools; `allow` keeps only the named tools; both together intersect:

```yaml
- insert:
    - id: hide-web
      name: '@deepseek-ai/dsh-global-tool-mask'
      config:
        deny: [web_fetch, web_search]
```

The mask follows the row's fiber: it applies when the preset's standing composition mounts and lifts when that composition is torn down. The names are checked at mount, so a mask that names no tool, or names one the host does not register, fails the preset loud with the registry's own message rather than silently masking nothing. Scoped registrations — tools the preset's own rows register — are never affected; the reserved PTC transport name cannot be masked either.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The row is one `ctx.effect()` around `ctx.tools.restrict(config)`. Every rule — scoped context required, non-empty filter, known names, the reserved transport name — belongs to the registry and is enforced there; the row adds a `Config` schema so a hand-written composition is validated at load.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `global-tool-mask` function plugin: `name`, `inject`, `Config`, `apply` |
| — | No runtime invariant companion is published; the registry owns the restriction's lifetime and reports the mask through its own views. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these when the question is what the mask acts on or where the row lives.

- [Tool registry](../../core/tools/README.md) — `tools.restrict()`, the layered views, and why a restriction requires a scope.
- [Agent presets](../agent-presets/README.md) — the compositions and user patch layers this row is inserted into.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the tool registry: the row removes tool schemas from the request the registry assembles for the scoped agent and registers no prompt, schema, or result of its own.

#### KV Cache effect

None of its own; the registry assembles the tool list, and a mask changes which schemas that list carries for the sessions of one preset from their first request onward.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the row will not do. They are current package constraints, not a task backlog.

- **Global tools only** — the mask cannot hide a tool a row of the same preset registers; disable that row instead.
- **Mount-time names** — a tool registered after the preset mounted is not retroactively judged: a name the host adds later cannot have been in the mask, and a name the host stops registering leaves the mask as it was.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
