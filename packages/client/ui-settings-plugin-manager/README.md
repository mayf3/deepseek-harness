---
description: "Plugin management tab in Web Plugins settings for the dsh web client: install packages through pnpm, enable and disable bundles, retry failed ones, and compose rows into the global user layer or one agent preset's."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-plugin-manager

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-settings-plugin-manager` contributes the **Manage plugins** tab to the Web Settings Plugins section. The tab reads the profile's packages through `ctx.remote.plugins.list()` and the preset compositions through `ctx.remote.pluginInventory.list()` the first time it is selected, and re-reads after every action and every forwarded `plugins/changed` event, so a change made from the CLI or another browser shows without a manual refresh. The page speaks two nouns without showing them: a *plugin pack* (a bundle) switches on and off as a whole and serves every session; a *plugin* (a plugin module) joins a preset or every session through **Add to…**. The **Installed** group lists one card per package with its display name and its one-line description; a pack carries its switch, a plugin its **Add to…** menu, a built-in pack a *Built-in* mark and a locked switch, and a card is tagged only when a restart is pending or something is wrong. An expanded card shows the version, the source, a pack's components — a count line, the failing components one line each with the failure, the off ones as chips under why they are off, and the rest as chips behind **Show all** with a filter — and **Uninstall**; entry ids, module names, kinds, and probe facts stay off the page. A preset's composition is not on this tab: the package contributes it to the preset's detail page in the Agent presets section as the **Capabilities** section — the same cards, harness modules named through the tab's dictionary and installed ones through their manifest with a *Local* mark, a switch per card, **Delete** for rows the user added, and an **Add** menu. The install dialog takes a package name, a local path, or a Git URL, keeps pnpm's output behind a fold that opens on failure, and words the outcome per package. A disable with dependents and every uninstall wait for a confirmation that names what still uses the package. Without a profile runtime the tab says it is unavailable and offers nothing.

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

**Add** opens the install dialog. Enter what pnpm accepts — `dsh-better-sidebar@latest`, `/path/to/plugin`, a Git URL — and choose whether a newly installed pack is enabled right away. The dialog shows the run's progress with pnpm's output behind **Show install log**, which opens on its own when the run fails, and cannot be closed while the run is in flight. Once pnpm exits, one sentence per package says what happened: a pack installed and enabled, a pack installed and waiting for its switch, a plugin installed and ready to join a preset, a package that is not a DSH plugin removed again, or a pack removed again because its row id conflicts with an installed one — the last with the Host's reason. A run or any other action the Host refuses because another change is still running, or because a session is running, shows that refusal in the Host's words.

### Switching a plugin pack

A pack's switch calls `plugins.enable` or `plugins.disable`. On a live-reload profile the tree recomposes before the switch settles; a profile that applies layer changes at its next start reports the change as *restart needed*, and the tab names every such package in a banner until the restart. A pack the probe refused reads as a *problem* with the probe's reason in its expanded card and cannot be switched on; a pack whose components failed offers **Retry** in its expanded card, beside **Uninstall**. A built-in pack carries a locked switch. A disable first asks the Host what it would strand and skips the confirmation when nothing does.

### Adding a plugin to a preset

A plugin's card carries **Add to…**, listing every session and each preset; a target the plugin already joined is marked and disabled, and a package that declares several importable modules nests the targets under each module. The choice writes a row naming the module into the global user patch file or one preset's, through `plugins.addRow`. A preset's composition is managed on the preset's own detail page in the Agent presets section, where this package contributes the **Capabilities** section: one card per row with its switch, **Delete** on a row the person added, and an **Add** menu over the installed modules the preset does not carry yet. A switch writes `disabled: true` into that preset's user patch layer or removes the key again — a row the preset itself switched off stays locked, because the layer can only deny. Running and off are what the switch shows; no card tags them. Rows that declare no id cannot be switched.

### Reading a failure

The last action's outcome sits above the groups: a restart notice, a done notice, or the failure with the Host's own reason — a probe refusal, a rejected recomposition, a row id already taken. Dismiss it or let the next action replace it.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Registration

The browser plugin registers one localized `settings.plugins.tab` contribution with id `manage` and order -10, before the configuration tab, and one `settings.agentPreset.detail` contribution with id `plugins` — the Capabilities section of every preset's detail page, over the same store. Registration uses `ctx.slots.inject()`, so it follows late tab declaration, redeclaration, locale changes, and teardown without importing the section owner. Preset names resolve through the shared `presetDisplayText` fold over [`ui-agent-preset`](../ui-agent-preset/README.md)'s dictionaries. Harness modules in a preset resolve their display name and one-liner through the tab's own dictionary — `name.<slug>` and `desc.<slug>`, tried by the composition row id first (four subagent rows share one module) and then by the unscoped module name without its `dsh-` prefix — and only for modules under the `@deepseek-ai/` scope; a third-party module reads its installed package's `dsh.title` and `description`, or an addable module's own title.

### The store

`PluginManagerController` holds one snapshot: the read status, the packages, the preset groups, the busy keys, the notice, the install dialog, and the pending confirmation. `load` folds concurrent reads into one in-flight read plus one rerun, so an invalidation landing mid-read is never lost. Every action runs under a busy key — the package name, or `<target>:<rowId>` for a row — turns a refused answer into the notice with the Host's code and reason, and re-reads afterwards whatever happened. The plugin's `apply` subscribes `plugins/changed` and `connection/reset` to reload a tab that has rendered once, and `plugins/install-log` to fold chunks whose spec matches the open run.

### Confirmation

`disable` and `uninstall` open the confirmation and ask `plugins.dependents`; the answer for a confirmation that has since changed is dropped. A disable with an empty answer confirms itself. The dialog words each dependent — the rows injecting a service the package provides, by their harness names, and the user-layer rows naming the package, by their package title and the layer they sit in — and its confirming button stays disabled until the answer arrives. The action the confirmation guards is captured when it opens and runs only through that button.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the settings section, the Remote calls, and the Host-side manager.

- [ui-settings-plugins](../ui-settings-plugins/README.md) — the Plugins section this tab registers into.
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

- **Global user-layer rows are not listed per package** — a row added to every session marks that target in the package's **Add to…** menu and shows in its dependents, not on the card; removing it goes through the patch file or a future row list.
- **Names for harness modules live in this tab's dictionary** — a new first-party agent-plane module reads by its short module name until `name.<slug>` and `desc.<slug>` are added here.
- **One install at a time** — the dialog runs one pnpm command; a second spec waits for the first to finish.
- **No version picker** — the spec is typed as pnpm accepts it; the tab neither lists registry versions nor offers upgrades.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. This package owns a Settings contribution over Host-owned facts.
