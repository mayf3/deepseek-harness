# Agent Note: Plugin management lands in Web settings

Status: implemented

English | [中文](2026-09-04-plugin-management-in-web-settings.zh.md)

## Problem

The Host could manage a profile's plugins — install, enable, disable, retry, compose rows into a preset — and resolve a settings namespace per named scope, but the browser exposed none of it. The Plugins section had a configuration tab over the global instance of each namespace and a read-only list; a person who wanted the values of one preset, or a bundle switched on without the CLI, had no surface. The settings client read one `settings.describe` answer and bound every namespace globally, so a per-preset value had no path from the document to a card.

## Decision

**One mirror per settings scope.** `ui-settings` keeps a `SettingsMirrorRegistry`: the global mirror as before, and one mirror per named scope created the first time a consumer binds or describes it. A `settings/document-updated` event names the scope it landed in; a global commit reloads every mirror, because a named scope resolves over the global section, and a scoped commit reloads that scope alone. `bind({ namespace, scope })` derives from the scope's mirror and passes the scope on every write; the snapshot carries `scope`, `registered`, and `inherited`.

**Cards stage per scope, components stay scope-blind.** `ui-settings-plugins` holds one `ScopeSelection` for the configurable tab and a `ScopedCardForms` per card: one `CardForm` per scope, bound lazily, with drafts that belong to the scope they were typed under. The card components read the same hooks and call the same actions, which route to the selected form at call time. A field a named scope does not override reports `inherited` when the global user layer carries it; a reset stages the inherited value. The tab's switch lists the roster's presets plus any scope the document holds a section for. The filesystem skill provider gets its first card, a line-list of extra roots.

**A separate tab for management.** `ui-settings-plugin-manager` registers the **Manage plugins** tab between configuration and the read-only list. It reads packages from the `plugins` Remote and preset compositions from `pluginInventory`, re-reads after every action and every `plugins/changed`, and streams `plugins/install-log` into its install dialog. Destructive actions wait for an acknowledged confirmation listing the dependents the Host reports. The read-only list gains the provenance facts the Host already carried: which layer inserted a preset row and who switched a row off.

**The install verb is `add`.** The client namespace service reserves `install` and `remove` for its own members and refuses a mounted method of that name at page load, after every unit suite has passed. The Host's method is `plugins/add`, as on the CLI, and `packages/api/remotes/tests/remote-method-names.host.spec.ts` checks every `@Remote('<name>')` in the workspace against the names the gateway's own source reserves.

**The web e2e scaffold can mount a profile runtime.** `launchWebScaffold({ profileRuntime })` links fixture packages into the scaffold profile and mounts `ProfileRuntime` over it with `patchReload: 'startup'`, so the manager has a profile to manage while the booted tree never recomposes under a scenario.

## Alternatives considered

**An ambient scope selection inside `ui-settings`.** Rejected: surfaces outside the plugins tab bind global-only namespaces, and a page-wide selection would retarget them.

**Management controls inside the read-only list.** Rejected: the list projects rows of the live tree; management is per package, over the profile manifest, with an install run and confirmations that need their own state.

**Keeping `install` and special-casing the client mount.** Rejected: the reserved names are the service's own members; renaming one method is cheaper than a second lookup path in the gateway.

## Consequences

A preset's settings are editable beside the shared ones, and the document's `scopes.<id>` tree is what the scoped form writes. The plugin manager is usable from the browser end to end: install, switch, retry, uninstall, and compose rows into a preset. Existing plugin-configuration goldens move: the section grows a tab and a scope row.

## Testing

`packages/client/ui-settings/tests` pin the registry's routing and the scoped bind; `packages/client/ui-settings-plugins/tests` the scoped forms, the switch, the skills card, and the inherited badge; `packages/client/ui-settings-plugin-manager/tests` the store's reads, actions, install run, confirmations, and the tab's rendering; `packages/client/ui-settings-plugin-inventory/tests` the provenance facts. `apps/web/tests/plugin-manager.e2e.ts` drives the manager over a scaffold profile runtime and writes one field under a preset scope; `plugin-config` and `settings-chrome` goldens are re-recorded for the new tab and scope row.
