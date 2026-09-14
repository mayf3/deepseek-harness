---
description: "Enable profile plugins and install, remove or select bundles from the Web settings page or an agent."
kind: "package-reference"
---

# @deepseek-ai/dsh-plugin-manager

English | [中文](README.zh.md)

## Summary

Manage the current profile's plugins without editing configuration by hand. Enable or disable individual plugin entries, select installed bundles, and install or remove external bundles. Live profiles apply configuration changes immediately; startup-only profiles retain their running composition until restart. Changes affect every session using the profile.

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

Base-backed profiles provide the manager. In Web Settings, open Plugins and select Plugin list to manage bundles and uniquely addressable global plugin entries. Agent-preset rows remain read-only. The `plugin_manager` tool exposes the same operations.

A plugin toggle writes only its `disabled` override in the profile's `cordis.patch.yml`. A bundle toggle changes `package.json`'s ordered `dsh.profile.bundles` list. Disabling retains the dependency; enabling appends the bundle at the end, which can change configuration precedence. Installation enables a new bundle by default. Home and invocation patches retain their higher priority.

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

The service and `dsh plugin` share the package operations in [operations.ts](src/operations.ts). The launcher supplies the current profile; [DSH HMR](../hmr/README.md) serializes module reloads, file watching and management writes. Each refresh re-reads bundle selection and patch layers, updates the original root Include, and awaits removed plugin resources as well as the remaining Loader tree. Package operations hold the profile manifest lock; file watchers read the completed state after its release.

Saved configuration, package-manager completion and runtime activation are separate outcomes. Failures retain partial changes and diagnostics rather than automatically restoring files or packages. No invariant companion is published because the manager reads files and Loader state directly and owns no independent state projection.

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
- Package failures may leave dependencies partially changed. Diagnostic logs remain under the profile's `.plugin-manager/logs` directory.
- Desktop package operations remain owned by the Desktop shell.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
