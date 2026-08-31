---
description: "Permission preset surfaces for the Web GUI: the General-settings default row and the /permission picker for the current session; for users and maintainers of permission policy."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-permission-presets

English | [中文](README.zh.md)

## Summary

This package provides permission preset surfaces for two lifetimes in the Web GUI: a General-settings row chooses the default for later sessions without switching the current session, while a picker on the host `/permission` command switches the current session through one flat live preset list with the active value marked. Canonical built-in names render as locale-owned product labels, explicit host labels remain unchanged, unknown kebab-case names render in title case, and the current-session-only `auto` contribution appears as `Auto review` with an `EXP` badge. Choosing full access through either surface or Auto review through a visible picker requires its own explicit risk acknowledgement; an already argued `/permission <preset>` command executes directly. Both surfaces write through the host command or settings owner, while the current-session projection remains authoritative for the picker and composer chip.

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

Mount this plugin alongside the settings and commands packages; the permission row then appears in General settings, and the `/permission` picker replaces the bare command invocation. The current-session picker is available exactly while the projection key is present; a permission-less composition shows neither picker nor Settings row.

### The picker

A pick submits the `/permission <preset>` command line. The argued path (`/permission <preset>` typed directly) still switches directly; the decoration replaces only the bare invocation. The built-in labels are `Read Only`, `Workspace Write`, `Full access`, and `Auto review` in English and `仅可查看`, `工作区内修改`, `完全权限`, and `Auto review` in Chinese. Explicit host labels remain unchanged, unknown kebab-case names render in title case, and `auto` carries an `EXP` badge plus an experimental-risk confirmation. `custom` is display state, never a target.

### The Settings row

The row derives its options from the host's dynamic `defaultPreset` enum, uses the same localized built-in labels as the current-session picker, and writes one settings mutation. Current-session-only contributions such as `auto` are absent. The value applies only when a later session is created; changing it never switches or rewrites the current session.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The General row reads the explicitly exposed `permission` Settings descriptor through `ctx.settingsScope` and writes one `settings.mutate` path operation with the descriptor revision; its observable rides the slot system's `hooks` compartment, so the renderer owns React hook binding, and a push invalidation refetches the descriptor. The value is read only when a later session is created. The current-session surface is a popupSelect decoration hung on the host `/permission` command (`ctx.commandUi.decorate`): the host command keeps its slash-menu row, argued path, and durable lifecycle logging, while the decoration replaces only the bare invocation with the picker. Options and the active mark read the session's `permissions` projection — the same host-computed select the composer chip renders. Full access and Auto review each carry a localized `confirmation` payload; Auto also carries the badge rendered by the shared popup shell.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the permission surface is not enough. They move from the browser surfaces to the host policy and the command shell.

- [dsh-permission-presets](../../interaction/permission-presets/README.md) — the host-side permission preset policy these surfaces write.
- [ui-commands](../ui-commands/README.md) — the popupSelect shell the `/permission` decoration registers into.
- [ui-conversation](../ui-conversation/README.md) — the composer chip that renders the same permissions projection.
- [Client package map](../README.md) — adjacent browser UI packages.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the permission facts its two surfaces write: the Settings row causes a future session to start with whole-value knob events, while the `/permission` picker appends the selected current-session preset. Sandbox and approval consumers resolve their own knob events; selecting `auto` additionally activates the host Auto integration's independent per-call reviewer.

#### KV Cache effect

No direct invalidation; the knob consumers own any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the current permission surfaces. They are current package constraints, not a general policy comparison or a task backlog.

- **The Settings row is Web-only** — non-Web clients may still switch the current session through `/permission`, but do not receive this browser contribution.
- **Auto review is current-session-only** — the General-settings row intentionally omits it, and only visible picker selection receives the experimental confirmation; an explicitly typed `/permission auto` is already explicit consent.
- **Preset descriptions come from the host** — localized built-in labels may therefore appear beside a description written in another language.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
