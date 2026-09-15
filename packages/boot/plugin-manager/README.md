---
description: "Enable profile plugins and install, remove or select bundles from the Web settings page or an agent."
kind: "package-reference"
---

# @deepseek-ai/dsh-plugin-manager

English | [中文](README.zh.md)

## Summary

Manage the current profile's plugins without editing configuration by hand. Enable or disable individual plugin entries, select installed bundles, and install or remove external bundles. With HMR enabled in YAML, configuration changes apply immediately; without HMR, the running composition remains until restart. Changes affect every session using the profile.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Failure behavior](#failure-behavior)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Base-backed profiles provide the manager. In Web Settings, open Plugins and select Plugin list to manage bundles and uniquely addressable global plugin entries. Agent-preset rows remain read-only. The `plugin_manager` tool exposes the same operations and is disabled by default.

Enable the tool explicitly in the profile patch; agents using a preset also need its `tool-plugin-manager` entry enabled.

```yaml
- id: tool-plugin-manager
  disabled: false
```

A plugin toggle updates only `disabled` in the last matching override in the profile's `cordis.patch.yml`, or appends an override when none matches. Matching uses the entry id and any module-name assertion. A bundle toggle changes `package.json`'s ordered `dsh.profile.bundles` list. Disabling retains the dependency; enabling appends the bundle at the end, which can change configuration precedence. Installation enables a new bundle by default. Home and invocation patches retain their higher priority.

When pnpm 11 blocks dependency scripts, the failed installation reports pending package names. Web offers **Allow these scripts and retry**; the tool accepts the same names through `approvedBuilds` on `install_bundle`. Approval persists by package name in this profile, permits commands with the host user's permissions, and survives another installation failure. Only currently undecided names can be approved; existing denials and wildcard rules cannot be overridden through this action. Installation cleanup retains these decisions. Retry preserves the original activation choice.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `outputBytes` | `16384` | Maximum pnpm diagnostic bytes returned per operation; the full output remains in the returned log path. |
| `lockWaitMs` | `120000` | Maximum time in milliseconds to acquire the profile write lock. |
| `notificationDelayMs` | `250` | Delay in milliseconds for combining operation notices. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The service and `dsh plugin` share the package operations in [operations.ts](src/operations.ts). The launcher supplies the current profile; [DSH HMR](../hmr/README.md) serializes module reloads, file watching and management writes. Each refresh re-reads bundle selection and patch layers, updates the original root Include, and awaits removed plugin resources as well as the remaining Loader tree. CLI and service operations share the profile manifest writer lock to prevent concurrent package and manifest writes. HMR does not acquire that lock. Pnpm runs outside the HMR queue; installation selects the bundle after pnpm succeeds, while removal deselects and unloads the bundle before pnpm runs. Dependency-only changes do not trigger configuration reloads.

Results contain the last attempted stage, target, saved-state change, application status and error codes. Web dictionaries render management text; pnpm and Loader diagnostics remain unmodified. Unrelated pre-existing inactive entries return warnings; new or changed failures and inactive explicit enablement targets fail the operation. The CLI inherits authentication variables and terminal descriptors; service operations use a scrubbed environment and captured output. No invariant companion is published because the manager reads files and Loader state directly and owns no independent state projection.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [App boot](../app-boot/README.md) — profile layers and startup policy.
- [Plugin inventory](../../host/plugin-inventory/README.md) — current Loader and preset observations.
- [Plugin settings](../../client/ui-settings-plugin-inventory/README.md) — Web controls.

<a id="model-experience"></a>
## Model Experience

### Management tool

#### What the model sees

The [`plugin_manager` tool](../../../docs/tool-catalog.md#deepseek-aidsh-plugin-manager) lists plugin entries and bundles and performs profile-wide changes. Its results include saved-state changes, application status and package diagnostics.

#### Token effect

The tool declaration is present when its consumer is mounted; each invocation adds its returned inventory or change result.

#### KV Cache effect

Tool results append to the transcript. Enabling or disabling other tools can change subsequent tool declarations and their cache reuse.

### Configuration change notices

#### What the model sees

Consecutive operation results are combined within `notificationDelayMs` and injected into each affected live Agent. Notices include the application outcome, disclose omitted results when the configured output bound is reached, and do not wake an idle Agent.

#### Token effect

Notices add conditional user-message context to each affected Agent.

#### KV Cache effect

Notices append context; they do not rewrite earlier messages.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Package replacements require restarting the process to load a fresh JavaScript module generation.
- Startup-only profiles cannot remove packages used to start the current process; stop it and use `dsh plugin`.
- The manager cannot disable its own management components, change another profile, or edit an agent preset's composition.
- Package failures may leave dependencies partially changed. Inactive dependencies with missing files remain removable. Diagnostic logs remain under the profile's `.plugin-manager/logs` directory.
- Management results describe Host activation. Browser synchronization failures appear separately in the plugin list.
- Desktop package operations remain owned by the Desktop shell.

<a id="failure-behavior"></a>
### Failure behavior

Failures preserve completed steps and report the actual remaining state. Profile dependencies without valid bundle metadata remain visible and removable, with enablement unavailable.

| Failed operation | Handling |
|---|---|
| Install: pnpm or bundle validation fails | Attempt to remove only dependencies newly added by this operation and identified unambiguously. Do not restore existing packages. Report installation failure. |
| Enable: saving selection or loading fails | Keep the installed dependency and any saved selection. Report enablement failure; allow repair, disablement or removal. |
| Remove: any step fails | Stop at the failed step. Preserve completed changes, retain remaining dependencies for retry, and report removal failure. Do not re-enable the bundle. |

Installation finishes after pnpm and bundle validation succeed; subsequent enablement failure does not undo installation. Removal proceeds in order: remove the bundle from `dsh.profile.bundles`, unload its runtime contributions, then run `pnpm remove`. A failed step prevents subsequent steps.

Installation cleanup is attempted once. If it fails or the new dependency cannot be identified, preserve the actual state and report the original failure together with cleanup diagnostics and remaining dependencies. Do not recursively undo cleanup. Cleanup covers dependencies and bundle selection only; user-authored patch configuration, application data and diagnostic logs remain untouched.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
