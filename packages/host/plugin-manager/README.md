---
description: "Plugin management over the booted profile: the pluginManager service and the plugins Remote that install, enable, disable, and retry bundles, edit user-layer rows, and report every package's state."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-plugin-manager

English | [中文](README.zh.md)

## Summary

`dsh-host-plugin-manager` is the one place that changes what a running profile is composed of. The profile launcher composes the host tree from bundle layers and user patch files and, through `profileRuntime`, can recompose it while it runs; this service drives that: it runs pnpm in the profile directory to install or remove a package, moves a bundle in and out of the profile's layer list and recomposes the tree with the outcome, composes a bundle again when its rows failed at boot, adds and removes rows in the profile's global user layer or one agent preset's, and folds the manifest, the probe record, and the live tree into one view per package. The `plugins` Remote exposes each operation; every change is followed by a `plugins/changed` event and an install run streams pnpm's output as `plugins/install-log`. Client packages consume the Remote through the [`api-remotes`](../../api/remotes/README.md) assembly.

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

### What a package view says

`plugins/list` returns one view per package the profile knows: its template and installed bundles and every other installed dependency. A view carries the manifest facts (name, version, title, description, `engines.dsh`), what the package is (`bundle`, `plugin`, or `library`), who supplied it (`builtin` or `external`), when its rows mount (`boot` or `runtime`), whether it is installed and enabled, and a folded `status`: `running`, `partial`, or `failed` for an enabled bundle by how many of its rows are active; `disabled` for an installed bundle outside the layer list; `not-enableable` when the probe refused it, with the reason; `restart-required` when the manifest and the live tree disagree on a profile that applies changes at its next start; `plain` for a library or plugin module, which is added to a composition rather than enabled. Rows come from the live tree while the bundle is composed — phase, disabled-by, and the recorded failure of an isolated row — and from the probe record otherwise, with the ids the launcher will prefix them with. `addable` lists the modules the package declares in `dsh.plugins`, each with its default config and the probe's verdict, and for a plugin module its main export as `.` — the entry `addRow` accepts without a declaration.

### Installing and enabling

`plugins/add` takes a pnpm spec — a registry name, a `github:` or git URL, a tarball, an absolute path — runs `pnpm add` in the profile directory, records what pnpm wrote to `dependencies`, probes every new package in a child process, and leaves new bundles disabled unless `enable` was asked for. pnpm's output arrives as `plugins/install-log` chunks carrying the run's `jobId`; the last chunk carries the exit code. A non-zero exit, a spawn failure, or the timeout fails the call with `plugins/install-failed` and the tail of the log.

`plugins/enable` puts an installed bundle into the layer list and, on a live profile, recomposes the tree with it through the profile runtime. The recomposition is the Loader's own transaction: a bundle the tree rejects — a `boot`-stage bundle whose row throws — rolls back, the layer list is restored, and the call fails with `plugins/enable-failed` naming the reason, while the tree that was running keeps running. A `runtime`-stage bundle whose row fails is isolated instead: the call succeeds, the view reports the row's failure, and `plugins/retry` composes the bundle again from scratch. `plugins/disable` is the reverse; a template bundle, which is not a dependency, cannot be disabled. On a profile whose `patchReload` is `startup`, both write the manifest and report `effect: 'restart'`.

`plugins/uninstall` disables the bundle when enabled, drops every user-layer row that names one of the package's modules, runs `pnpm remove`, and forgets the probe record.

### Rows in user layers

`plugins/addRow` inserts a row naming one of the package's modules — its main export for a `plugin` package, or a `dsh.plugins` entry — into the profile's global `cordis.patch.yml` (`target: { kind: 'global' }`) or an agent preset's user layer (`{ kind: 'preset', preset }`, through the roster's `overlayPathFor`). The row id derives from the package name and subpath unless given; a taken id fails with `plugins/row-conflict`. `plugins/removeRow` removes an inserted row and `plugins/setRowDisabled` writes or removes a `disabled: true` for any row — deny-only, so a bundle's own `!!js` gate is restored rather than overridden. The global layer is recomposed live on the spot; a preset's layer reaches its next standing generation.

`plugins/dependents` says what disabling or removing a package would strand: services its rows provide that rows outside it inject, and user-layer rows naming its modules.

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

### One manifest, two writers

Every change reads the profile manifest afresh and writes it through the same app-boot helpers the `dsh plugin` command uses (`reconcileInstalledBundles`, `enableBundle`, `disableBundle`), so the CLI and the manager never disagree on the file. `dependencies` records what is installed; `dsh.profile.bundles` records what is enabled.

### pnpm runs through `node:child_process`

The subprocess seam scrubs secret-shaped variables and has no shell mode, and pnpm needs both the user's registry, proxy, and auth settings and, on Windows, the shell that resolves its `.cmd` shim. The manager therefore spawns pnpm the way the CLI does, with the parent environment and `shell` on Windows, and streams the child's output itself.

### Retry is disable then enable

The Loader's transactional update leaves an unchanged row alone, so a failed isolated row would not restart on a plain recomposition. Retry takes the bundle out of the layer list and puts it back: two recompositions, and the manifest ends as it began.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `PluginManager`: the `pluginManager` service, the `plugins` Remote methods, the pnpm runner, and the view fold |
| [`src/types.ts`](src/types.ts) | Wire payloads, the `plugins/changed` and `plugins/install-log` events, and the `plugins/*` failure codes |
| — | No runtime invariant companion is published; every view is folded from the manifest, the probe cache, and Loader-owned state on each call. |

Typert generates the Host and Client Remote artifacts exposed by `./typert` and `./remote`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these when the manager's contract is not enough: the runtime it drives, the files it edits, and the surface that renders it.

- [App boot](../../boot/app-boot/README.md) — the profile runtime, external bundle isolation, and the package probe.
- [Patch files](../../util/patch-file/README.md) — how user-layer rows are written.
- [Agent presets](../../preset/agent-presets/README.md) — the per-preset user layer a preset target writes.
- [Plugin inventory](../plugin-inventory/README.md) — the row-level read-only projection beside this service.

-----

<a id="model-experience"></a>
## Model Experience

None, as the host-side plugin manager registers nothing model-facing; the rows it composes own every registration they make.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the manager will not do for a client. They are current package constraints, not a task backlog.

- **Updating a loaded package needs a restart** — Node caches ESM modules by URL and a hoisted install keeps the path; `pnpm update` through `add` rewrites the files but the running tree keeps the old modules until the process restarts.
- **Dependents stop at injection** — a registry-type dependency (a tool, an LLM adapter) has no `inject` edge, so `dependents` cannot name a row that only reads what the package registered.
- **A preset row is not composed live** — the manager writes the preset's layer; sessions created afterwards compose it, sessions already running keep their generation.
- **No `engines.dsh` check yet** — the range is reported, not enforced against the running harness version.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
