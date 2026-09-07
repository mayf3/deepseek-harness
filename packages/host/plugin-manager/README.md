---
description: "The plugins Remote of the Web host: pluginManager as a Typert service that relays each call to the shared plugin manager over the booted profile and maps its failures onto Remote error codes."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-plugin-manager

English | [中文](README.zh.md)

## Summary

`dsh-host-plugin-manager` is the Web host's face of plugin management. It mounts `pluginManager` as a Typert service and exposes the `plugins` Remote — `list`, `add`, `uninstall`, `enable`, `disable`, `retry`, `addRow`, `removeRow`, `setRowDisabled`, `dependents` — each method relaying to the [`dsh-plugin-manager`](../../boot/plugin-manager/README.md) `PluginManager` built over this context, and each `plugins/*` failure crossing the wire as a `RemoteError` of the same code. What the operations do, and the `plugins/changed` and `plugins/install-log` events that follow them, belong to that package; this one reads the profile runtime, the preset roster, and the agent registry off the context and hands them over. Client packages consume the Remote through the [`api-remotes`](../../api/remotes/README.md) assembly.

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

Mount the row in a host composition beside the plugin inventory; the web bundle does. The row injects only the Loader and resolves the profile runtime per call, so a composition booted without the profile launcher still starts and answers every call with `plugins/unavailable`.

### The Remote

`plugins/list`, `plugins/add`, `plugins/uninstall`, `plugins/enable`, `plugins/disable`, `plugins/retry`, `plugins/addRow`, `plugins/removeRow`, `plugins/setRowDisabled`, and `plugins/dependents` carry the arguments and answers the manager's methods of the same names define; the [manager README](../../boot/plugin-manager/README.md#use-this-package) documents each. The `./types` export re-exports the manager's payload types unchanged, so a client imports one vocabulary.

### Failure codes

A manager failure reaches the client as a `RemoteError` with the same `code` and `details`: `plugins/unavailable`, `plugins/not-installed`, `plugins/not-enableable`, `plugins/enable-failed`, `plugins/install-failed`, `plugins/row-conflict`, `plugins/busy`, and `plugins/agents-running`, each declared in the Remote failure map with the manager's details type. The manager's generic refusal, `plugins/bad-request`, crosses as the Gateway's `gateway/bad-request`. Any other error the manager throws propagates untouched, which the Gateway reports as `gateway/internal`.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `pnpmCommand` | `pnpm` | The executable, resolved through `PATH` like the `dsh plugin` command. |
| `installTimeoutMs` | `600000` | Bound on one install or remove run. |
| `probeTimeoutMs` | `20000` | Bound on one package probe. |
| `installLogTailBytes` | `16384` | How much trailing output an install failure reports. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### A relay, not a second manager

The constructor builds one `PluginManager` with readers into the context — `ctx.get('profileRuntime')`, `ctx.get('agentPresets')`, and the running-agent count from `ctx.get('agents')` — so what is composed is read when a call arrives, not when the row mounts. Every Remote method is `relay(() => this.manager.x(...))`: a `PluginOperationError` becomes the Remote error of its code through one exhaustive switch, and anything else is rethrown. Tests hand a manager in through `PluginManagerInternals.manager`; the spawn and probe seams pass through to the manager.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `PluginManagerRemote`: the `pluginManager` service, the ten `plugins` Remote methods, and `remoteErrorOf` |
| [`src/types.ts`](src/types.ts) | The manager's types re-exported, and the `plugins/*` codes declared in the Remote failure map |
| — | No runtime invariant companion is published; the row holds no state of its own. |

Typert generates the Host and Client Remote artifacts exposed by `./typert` and `./remote`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these when the relay's contract is not enough: the manager behind it and the surface that renders it.

- [Plugin manager](../../boot/plugin-manager/README.md) — what every operation does, the events, and the failure codes.
- [App boot](../../boot/app-boot/README.md) — the profile runtime the manager drives.
- [Plugin inventory](../plugin-inventory/README.md) — the row-level read-only projection beside this service.

-----

<a id="model-experience"></a>
## Model Experience

None, as the Remote registers nothing model-facing; the rows the manager composes own every registration they make.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the Remote will not do for a client. They are current package constraints, not a task backlog.

- **What the manager cannot do, the Remote cannot either** — the [manager's limits](../../boot/plugin-manager/README.md#known-limitations-and-deferred-work) apply unchanged: a loaded package updates at the next restart, dependents stop at injection, a preset row composes for later sessions, `engines.dsh` is reported and not enforced.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
