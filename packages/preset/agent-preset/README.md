---
description: "Define an Agent’s child plugins in ordinary Cordis YAML. Declare several presets and let sessions select one. Definitions load eagerly, and edits affect subsequently created Agents."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-preset

English | [中文](README.zh.md)

## Summary

Define an Agent’s child plugins in ordinary Cordis YAML. Declare several presets and let sessions select one. Definitions load eagerly, and edits affect subsequently created Agents.

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

```yaml
- id: agent-preset-registry
  name: '@deepseek-ai/dsh-agent-preset-registry'
  config:
    default: standard
- id: preset-standard
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: standard
    plugins: []
```

| Field | Default | Meaning |
|---|---|---|
| `id` | required | Stable preset identifier |
| `plugins` | required | Child plugin entry list |
| `name` | unset | Display name |
| `description` | unset | Display description |
| `order` | unset | Roster order |

The declaration row’s `id` addresses Loader edits; `config.id` is the preset identity saved by sessions. Child entry IDs may be omitted and assigned by Loader.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[index.ts](src/index.ts) registers a definition and returns its disposer to Cordis. The plugin’s group marker preserves child `!!js` expressions until their own plugins load. The [registry](../agent-preset-registry/README.md) owns revision retention and release.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Scope](../../core/scope/README.md) — Registration isolation.
- [Agent](../../core/agent/README.md) — Session runtime.
- [Cordis](../../../docs/cordis-primer.md) — Plugin configuration and lifecycle.

<a id="model-experience"></a>
## Model Experience

Indirectly, through the declared plugins, which own model-visible tools and prompts.

#### KV Cache effect

A live Agent’s composition stays stable; new Agents can use an updated definition.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Requires the `agentPresets` service. Duplicate preset IDs fail declaration loading. Declarations provide no directory, file-copy or file-delete operations.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. This plugin submits registry-owned definitions and has no independently mutable runtime state.
