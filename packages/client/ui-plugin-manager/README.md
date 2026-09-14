---
description: "Manage installed plugin packages and global rows from the Web sidebar."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-plugin-manager

English | [中文](README.zh.md)

## Summary

Use the **Plugins** entry in the Web sidebar to manage installed packages. Switch bundle layers on and off, inspect their rows and failures, add declared modules to the global user layer, and install packages while watching pnpm output. Dependency-sensitive changes and uninstalling ask for confirmation. Global configuration remains in Settings.

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

Select **Plugins** in the sidebar. The page reads packages and global composition through `api-remotes` when first opened. Global configuration remains in the Settings **Plugins** section.

### Installing a package

**Add plugin** accepts a pnpm package spec, local path or Git URL. The dialog shows the command, streamed output, and completion result, and stays open during installation. New bundles can be enabled immediately. Undeclared packages remain installed; invalid or conflicting bundle declarations may be rejected with the Host’s reason. A successful installation does not certify that a module can activate.

### Switching a plugin pack

A pack’s switch changes its enabled layer selection. Live profiles recompose before the operation completes; startup-only profiles show a restart notice. Runtime failures leave successful components active and keep the pack enabled, with **Retry** and **Uninstall** on its page. Unreadable bundle declarations prevent enabling. Built-in packs have locked switches. Disabling first checks dependents and asks for confirmation when needed.

### Switching one row of a pack

A row's switch on the pack's page calls `plugins.setRowDisabled` against the profile's global user layer: off writes `disabled: true` for the row's id into the profile's `cordis.patch.yml`, on deletes that key again. The tree recomposes at once, so the row's host half unmounts or mounts while the rest of the pack keeps running; a browser half the pack's own client bundle mounts for every component stays until the page reloads. The switch appears only where it acts at once — an external pack that is switched on, on a profile that applies patches while it runs; built-in packs, packs that are off, and profiles that apply patches at their next start list their rows read-only. A row the pack itself keeps off, by a `disabled: true` row or a `!!js` gate, is locked with the reason, because the user layer only ever denies. A failing row can be switched off; a row another layer already owns has nothing mounted to switch. Switching a row off first asks the Host what other rows inject of what the row provides, with the switch inert meanwhile, and opens a confirmation naming them only when there are any; a row nothing depends on switches off at once, and switching on never asks. A list longer than ten rows gets a filter over the row ids.

### Adding a plugin globally

A package with explicit `dsh.plugins` declarations offers **Add globally** for each module. An already-added module has a disabled action. Addition writes the profile's `cordis.patch.yml` without an import precheck. Packages without recognized declarations remain uninstallable and have no Add action.

### Reading a failure

The page separates enablement, running phase and current issues. A missing service reads as *waiting for a dependency*. A row whose old instance remains active after invalid configuration reads *Running; latest update failed* with the actual error. The pack detail also identifies issues in other components its patch affects, preserving their original ownership. Runtime changes refresh the page after Loader and profile recomposition settle. Action refusals retain the Host’s reason.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

Package management uses the profile’s dependency records: installed bundles can be toggled and installed packages removed; installation-owned bundles remain locked. This distinction does not select startup failure policy.

<details>
<summary>Implementation internals — click to expand</summary>

### Registration

The browser plugin registers the `plugins` sidebar entry and its `main` panel through `ctx.slots.inject()`, so both follow late slot declaration, locale changes and teardown. The page is global and belongs to no Session. Shipped module labels come from its dictionary; third-party display text comes from package metadata.

### The store

`PluginManagerController` owns the package and global-module snapshot, busy keys, notices, install progress and confirmations. It coalesces overlapping reads, refreshes after operations and Host changes, and ignores late results after disposal. Install output is grouped by job id.

### Confirmation

`disable` and `uninstall` open the confirmation and ask `plugins.dependents`; the answer for a confirmation that has since changed is dropped. A disable with an empty answer confirms itself. The dialog words each dependent — the rows injecting a service the package provides, by their harness names, and the user-layer rows naming the package, by their package title and the layer they sit in — and its confirming button stays disabled until the answer arrives. The action the confirmation guards is captured when it opens and runs only through that button.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the settings section, the Remote calls, and the Host-side manager.

- [ui-sidebar](../ui-sidebar/README.md) — the panel list the Plugins entry registers into; [ui-layout](../ui-layout/README.md) — the main slot the page occupies.
- [api-remotes](../../api/remotes/README.md) — the Remote BFF surface behind `plugins.*` and `pluginInventory.list()`.
- [plugin-manager](../../host/plugin-manager/README.md) — the Host-side manager this page drives.

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
- **Names for harness modules live in this page's dictionary** — a new first-party agent-plane module reads by its short module name until `name.<slug>` and `desc.<slug>` are added here.
- **One install at a time** — the dialog runs one pnpm command; a second spec waits for the first to finish.
- **No version picker** — the spec is typed as pnpm accepts it; the page neither lists registry versions nor offers upgrades.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. This package owns a sidebar panel and a Settings contribution over Host-owned facts.
