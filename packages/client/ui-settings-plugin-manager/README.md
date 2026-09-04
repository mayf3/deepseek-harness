---
description: "Plugin management tab in Web Plugins settings for the dsh web client: install packages through pnpm, enable and disable bundles, retry failed ones, and compose rows into the global user layer or one agent preset's."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-plugin-manager

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-settings-plugin-manager` contributes the **Manage plugins** tab to the Web Settings Plugins section. The tab reads the profile's packages through `ctx.remote.plugins.list()` and the preset compositions through `ctx.remote.pluginInventory.list()` the first time it is selected, and re-reads after every action and every forwarded `plugins/changed` event, so a change made from the CLI or another browser shows without a manual refresh. The global group lists one card per package with its trust, kind, stage, and status tags; a bundle carries a switch that puts it into or takes it out of the profile's layer list, and an expanded card shows the rows it contributes with their phase and failure, the built-in rows it overrides, the modules it declares addable — each with an **Add to…** menu naming the global layer and every preset — and the retry and uninstall actions the package offers. The session group shows the selected preset's composition with a switch per row and a remove action for rows the user added. The install dialog takes an npm spec, a local path, or a git URL, streams pnpm's output as `plugins/install-log` chunks arrive, and reports what the run added. A disable with dependents and every uninstall wait for an acknowledged confirmation that lists the services other rows inject and the user-layer rows naming the package. Without a profile runtime the tab says it is unavailable and offers nothing.

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

Open the Plugins section in Settings and select the **Manage plugins** tab. The tab reads no Remote during plugin activation — selecting it mounts the component, which then reads the packages and the preset compositions through `api-remotes`.

### Installing a package

**Add plugin** opens the install dialog. Enter what pnpm accepts — `dsh-better-sidebar@latest`, `/path/to/plugin`, a git URL — and choose whether a newly installed bundle is enabled right away. The dialog streams the run's output and, once pnpm exits, names the dependencies the run added; a non-zero exit keeps the output for reading. The dialog cannot be closed while the run is in flight. When the run finishes, the dialog lists the packages the Host removed again — one that is not a dsh package, or a bundle whose row id another layer owns — each with the Host's reason, under the installed names. A run or any other action the Host refuses because another change is still running, or because a session is running, shows that refusal in the Host's words.

### Switching a bundle

A bundle's switch calls `plugins.enable` or `plugins.disable`. On a live-reload profile the tree recomposes before the switch settles; a profile that applies layer changes at its next start reports the change as pending, and the tab names every such package in a banner until the restart. A built-in bundle's switch is locked; a bundle the probe refused cannot be switched on and shows the probe's reason. A disable first asks the Host what it would strand and skips the confirmation when nothing does.

### Composing rows

An expanded card lists the modules the package declares addable; **Add to…** writes a row naming the module into the global user patch file or one preset's, through `plugins.addRow`. The session group's preset switcher shows one preset's composition: a row's switch writes `disabled: true` into that preset's user patch layer or removes the key again, and a row the user added can be removed. Rows that declare no id cannot be switched here.

### Reading a failure

The last action's outcome sits above the groups: a restart notice, a done notice, or the failure with the Host's own reason — a probe refusal, a rejected recomposition, a row id already taken. Dismiss it or let the next action replace it.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Registration

The browser plugin registers one localized `settings.plugins.tab` contribution with id `manage` and order 5, between the configuration tab and the read-only list. Registration uses `ctx.slots.inject()`, so it follows late tab declaration, redeclaration, locale changes, and teardown without importing the section owner. Preset names resolve through the shared `presetDisplayText` fold over [`ui-agent-preset`](../ui-agent-preset/README.md)'s dictionaries, as the inventory tab does.

### The store

`PluginManagerController` holds one snapshot: the read status, the packages, the preset groups, the busy keys, the notice, the install dialog, and the pending confirmation. `load` folds concurrent reads into one in-flight read plus one rerun, so an invalidation landing mid-read is never lost. Every action runs under a busy key — the package name, or `<target>:<rowId>` for a row — turns a refused answer into the notice with the Host's code and reason, and re-reads afterwards whatever happened. The plugin's `apply` subscribes `plugins/changed` and `connection/reset` to reload a tab that has rendered once, and `plugins/install-log` to fold chunks whose spec matches the open run.

### Confirmation

`disable` and `uninstall` open the confirmation and ask `plugins.dependents`; the answer for a confirmation that has since changed is dropped. A disable with an empty answer confirms itself. The action the confirmation guards is captured when it opens and runs only through **Continue**.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the settings section, the Remote calls, and the Host-side manager.

- [ui-settings-plugins](../ui-settings-plugins/README.md) — the Plugins section this tab registers into.
- [ui-settings-plugin-inventory](../ui-settings-plugin-inventory/README.md) — the read-only list beside this tab.
- [api-remotes](../../api/remotes/README.md) — the Remote BFF surface behind `plugins.*` and `pluginInventory.list()`.
- [plugin-manager](../../host/plugin-manager/README.md) — the Host-side manager this tab drives.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side management surface that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the reach of the management view; they are current package constraints.

- **Global user-layer rows are not listed per package** — a row added to the global layer shows in the read-only list and in the package's dependents, not on the package card; removing it goes through the patch file or a future row list.
- **One install at a time** — the dialog runs one pnpm command; a second spec waits for the first to finish.
- **No version picker** — the spec is typed as pnpm accepts it; the tab neither lists registry versions nor offers upgrades.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. This package owns a Settings contribution over Host-owned facts.
