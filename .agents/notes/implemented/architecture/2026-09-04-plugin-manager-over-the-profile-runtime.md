# Agent Note: The plugin manager drives the profile runtime

Status: implemented

English | [中文](2026-09-04-plugin-manager-over-the-profile-runtime.zh.md)

## Problem

Installing a plugin was a terminal-only act: `dsh plugin --profile web add <spec>` ran pnpm, appended every bundle it found to `dsh.profile.bundles`, and the next start composed it. Nothing running could learn what was installed but not enabled, switch a bundle off without editing `package.json` by hand, add one package's module to the profile's user layer or to one agent preset, or say which rows a package's service kept alive. The Web surface could list rows through `pluginInventory/list` and nothing more, while the launcher's `profileRuntime` (previous note) already recomposed the tree on a user patch reload and `reconcileInstalledBundles` already separated installation from enablement. The missing piece was the host service that performs the operations and reports each package as one thing.

## Decision

**One service, one manifest.** `dsh-host-plugin-manager` provides `pluginManager` and the `plugins` Remote: `list`, `add`, `uninstall`, `enable`, `disable`, `retry`, `addRow`, `removeRow`, `setRowDisabled`, `dependents`. The install verb is `add`, as on the CLI: the client's namespace service reserves `install` and `remove` for its own members, and the mount refuses a method named after one. Every operation reads the profile manifest afresh and writes it through the same app-boot helpers the CLI uses — `reconcileInstalledBundles`, `enableBundle`, `disableBundle` — so the CLI and the manager cannot disagree on the file: `dependencies` says what is installed, `dsh.profile.bundles` says what is enabled. The profile runtime is resolved per call rather than injected, so the web bundle's row starts in a composition booted without the profile launcher and answers `plugins/unavailable`.

**Enablement is the Loader's transaction.** `enable` puts the bundle in the layer list and calls `profileRuntime.recompose({ reloadBundles: true })`, after `healProfilesModuleFallback` has linked the packages the bundle carries. A rejected recomposition — a `boot`-stage bundle whose row throws — is the Loader rolling back to the tree that was running; the manager restores the list and reports `plugins/enable-failed`. A `runtime`-stage bundle whose row fails is isolated by the contained group and reported per row. Because the boot audit does not run again, the manager calls `recordContainedStates` after a live recomposition, and `ContainedGroup.create` now records a row that resolved in the pending state instead of clearing it — a reload re-creates every row of a group, and a waiting row must keep its record through that. `retry` is disable then enable: the Loader's update leaves an unchanged row alone, so only leaving and returning restarts a failed isolated row.

**pnpm runs the way the CLI runs it.** Through `node:child_process` with the parent environment and `shell` on Windows, not through the subprocess seam: the seam scrubs secret-shaped variables pnpm needs for registries and proxies and has no shell mode for the `.cmd` shim. Output streams as `plugins/install-log` chunks under a job id; a non-zero exit, a spawn error, or the timeout is `plugins/install-failed` with the log tail. New packages are probed and left disabled unless the caller asked for `enable`.

**Rows go through the patch-file writer.** `addRow` inserts `{ id, name, config }` into the profile's `cordis.patch.yml` or an agent preset's user layer (through the roster's `overlayPathFor`), with the id derived from the package name and subpath; `setRowDisabled` is deny-only, writing or removing `disabled: true` so a bundle's `!!js` gate is restored rather than overridden. The global layer is recomposed on the spot; a preset's layer reaches its next standing generation.

**One view per package.** `list` folds the manifest, the probe record (cached under `.dsh-plugins/`, refreshed on a version change), and the live tree into a `status`: `running`, `partial`, or `failed` by active rows; `disabled`; `not-enableable` with the probe's reason; `restart-required` when a `startup`-reload profile's manifest and tree disagree; `plain` for a library or plugin module. Rows come from the tree while composed and from the probe otherwise, already carrying the prefixed ids the launcher will use; trust for a bundle outside the tree comes from `layerTrust`, the one rule `loadProfile` also applies.

## Alternatives considered

**Running pnpm through `ctx.subprocess`.** Rejected for this release: the seam has no shell mode and scrubs the environment; adding both to the seam for one caller is a larger change than the manager, and the CLI's spawn is proven.

**Restarting a failed row in place on `retry`.** Rejected: a row's options are unchanged, so the Loader's transactional update would not touch it; re-creating one row by hand would bypass the group's own create path and its failure record.

**Enabling a bundle without probing it.** Rejected: the probe is what turns a package that cannot import, or that resolves its own cordis copy, into a `not-enableable` view with a reason before the tree is asked to mount it.

## Consequences

A running Web host can install, enable, disable, retry, and remove third-party bundles and add their modules to the global layer or a preset without a restart on a live profile. Updating a loaded package still needs a restart (Node's module cache); `dependents` stops at injection edges; `engines.dsh` is reported, not enforced; the client UI arrives in a later PR.

## Testing

`packages/host/plugin-manager/tests/plugin-manager.spec.ts` boots a temporary profile through `boot()` with the profile runtime the launcher provides and a fake pnpm that edits the manifest the way the real one does: the view fold (installed, enabled, probed, waiting, user-disabled, first-party, hand-written manifests), install with and without enabling and its failures (exit code, spawn error, timeout, log tail), enable and disable live and on a `startup` profile, the boot-stage rollback, retry of a flaky isolated row, rows in the global and a preset's layer with conflicts, dependents by provided service and by user-layer reference, and uninstall. `packages/boot/app-boot/tests/contained-group.spec.ts` pins the waiting-row record across a reload.
