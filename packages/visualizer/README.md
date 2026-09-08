---
description: "The Visualizer package group: dormant Host authority and preset-scoped model tools for inline visual components."
kind: "package-group"
---

# visualizer/ — inline visual components

English | [中文](README.zh.md)

## Summary

Visualizer currently provides an independently loadable Host/model capability for temporary inline visuals. Its root Cordis service owns Host limits and authorized widget follow-ups, while a second entrypoint contributes prompt and tools from an Agent preset scope. Follow-up authority is bound to the retained immutable Session result, not to the lifetime of a presentation iframe. The default application compositions do not mount the authority, so the always-mounted model wrapper contributes nothing until an authority appears. A separately supplied compatible Client can consume the follow-up Remote and apply its own rendering limits; this package group does not yet provide or activate presentation.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

The group currently contains one Host package with separate authority and model entrypoints.

| Package | Role |
|---|---|
| [`tool-visualizer/`](tool-visualizer/README.md) | Provides the dormant Host authority, generated follow-up Remote, preset-scoped prompt, and Visualizer tools |

<a id="related-documentation"></a>
## Related documentation

- [Tool subsystem](../../docs/subsystems/tools.md) — model tool registration, execution, and logged results.
- [System prompt subsystem](../../docs/subsystems/system-prompt.md) — ordered prompt sections and context contributions.
- [Implementation decision](../../.agents/notes/implemented/feature/2026-08-29-inline-visualizer-cordis-extension.md) — dormancy, authority, and model-scope boundaries.

<a id="dev-note"></a>
## Dev Note

Keep Host authority in the root service and model policy in the same package's preset-scoped entrypoint. A compatible presentation Client may consume the generated follow-up Remote without adding a presentation contract to session/core types; none is mounted by the default compositions.
