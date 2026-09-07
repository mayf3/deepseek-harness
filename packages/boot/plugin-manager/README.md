---
description: "Plugin management over a dsh profile: the installer the dsh plugin command and the Web host share, and the manager over the booted profile that enables, disables, retries, edits user-layer rows, and reports every package."
kind: "package-reference"
---

# @deepseek-ai/dsh-plugin-manager

English | [中文](README.zh.md)

## Summary

`dsh-plugin-manager` is what changes a profile's plugins, with no Remote protocol attached. `PluginInstaller` needs only the profile on disk: it runs pnpm in the profile directory, probes every package a run added in a child process, and removes again what has no place in a profile — the `dsh plugin add` command uses it before any plugin starts. `PluginManager` needs the booted tree: it moves a bundle in and out of the profile's layer list and recomposes the tree through `profileRuntime`, composes a bundle again when its rows failed, adds and removes rows in the profile's global user layer or one agent preset's, says what disabling a package would strand, and folds the manifest, the probe record, and the live tree into one view per package. Every refusal or failure is a `PluginOperationError` carrying a `plugins/*` code; the Web host's [`dsh-host-plugin-manager`](../../host/plugin-manager/README.md) exposes the manager as the `plugins` Remote and turns each failure into a Remote error of the same code.

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

### Installing without booting

Build a `PluginInstaller` from the profile directory, the install anchor (the dsh app's `package.json`), a `loadProfile` that answers the profile's composed layers, the tooling bounds, and a sink for pnpm's output; then `add(spec)` or `remove(name)`:

```ts
const installer = new PluginInstaller({
  profileDir, profileName: 'web', installAnchor,
  loadProfile: () => loadProfile('dsh', 'web', installAnchor, undefined, { userLayer: false }),
  config: { pnpmCommand: 'pnpm', installTimeoutMs: 600_000, probeTimeoutMs: 20_000, installLogTailBytes: 16_384 },
  installLog: (chunk) => process.stdout.write(chunk.text),
})
const outcome = await installer.add('@acme/dsh-sql-tool')
```

`add` takes a pnpm spec — a registry name, a `github:` or git URL, a tarball, an absolute path — runs `pnpm add`, records what pnpm wrote to `dependencies`, and probes every new package. A successful `pnpm add` is not yet an installed plugin: a package that declares neither a bundle nor a plugin module, or a bundle whose row id a composed layer already owns, is removed again with `pnpm remove` and listed under `removed` with the reason; a package the probe refused stays installed for a view to explain. New bundles are left disabled and listed under `installedOnly`, so the caller decides whether to enable them — the CLI always does, the Web host only when asked. A non-zero exit, a spawn failure, or the timeout fails the call with `plugins/install-failed` and the tail of the log, and the profile manifest is restored to what it was before the run.

### Managing the booted profile

Build a `PluginManager` over the Cordis context and readers for what it needs per call — the profile runtime, the preset roster's layers, and the running-agent count — so a composition that gains or lacks one of them is answered at call time rather than at mount:

```ts
const manager = new PluginManager(ctx, {
  config,
  runtime: () => ctx.get('profileRuntime'),
  presets: () => ctx.get('agentPresets'),
  runningAgents: () => (ctx.get('agents')?.list() ?? []).filter(agent => agent.status === 'running').length,
})
```

`list` returns one view per package the profile knows: its template and installed bundles and every other installed dependency. A view carries the manifest facts (name, version, title, description, `engines.dsh`), what the package is (`bundle`, `plugin`, or `library`), who supplied it (`builtin` or `external`), when its rows mount (`boot` or `runtime`), whether it is installed and enabled, and a folded `status`: `running`, `partial`, or `failed` for an enabled bundle by how many of its rows are active; `disabled` for an installed bundle outside the layer list; `not-enableable` when the probe refused it, with the reason; `restart-required` when the manifest and the live tree disagree on a profile that applies changes at its next start; `plain` for a library or plugin module, which is added to a composition rather than enabled. Rows come from the live tree while the bundle is composed — phase, disabled-by, and the recorded failure of an isolated row — and from the probe record otherwise, under the ids their patches declare. `addable` lists the modules the package declares in `dsh.plugins`, each with its default config and the probe's verdict, and for a plugin module its main export as `.` — the entry `addRow` accepts without a declaration.

`add` is the installer's `add` guarded by the running-agent count, with `enable` putting every newly installed bundle into the layer list at once. `enable` puts an installed bundle into the layer list and, on a live profile, recomposes the tree with it through the profile runtime. The recomposition is the Loader's own transaction: a bundle the tree rejects — a `boot`-stage bundle whose row throws — rolls back, the layer list is restored, and the call fails with `plugins/enable-failed` naming the reason, while the tree that was running keeps running. A `runtime`-stage bundle whose row fails is isolated instead: the call succeeds, the view reports the row's failure, and `retry` composes the bundle again from scratch. `disable` is the reverse; a template bundle, which is not a dependency, cannot be disabled. On a profile whose `patchReload` is `startup`, both write the manifest and report `effect: 'restart'`. `uninstall` disables the bundle when enabled, drops every user-layer row that names one of the package's modules, runs `pnpm remove`, and forgets the probe record.

`addRow` inserts a row naming one of the package's modules — its main export for a `plugin` package, or a `dsh.plugins` entry — into the profile's global `cordis.patch.yml` (`target: { kind: 'global' }`) or an agent preset's user layer (`{ kind: 'preset', preset }`, through the roster's `overlayPathFor`). The row id derives from the package name and subpath unless given; a taken id fails with `plugins/row-conflict`. `removeRow` removes an inserted row and `setRowDisabled` writes or removes a `disabled: true` for any row — deny-only, so a bundle's own `!!js` gate is restored rather than overridden. The global layer is recomposed live on the spot; a preset's layer reaches its next standing generation. `dependents` says what disabling or removing a package would strand: services its rows provide that rows outside it inject, and user-layer rows naming its modules.

The manager runs one mutation at a time — a second call while one runs fails with `plugins/busy` naming the operation in flight — and `add` and `uninstall` refuse to change `node_modules` while a session is running, with `plugins/agents-running`. Every change is followed by a `plugins/changed` event on the context, and an install run emits pnpm's output as `plugins/install-log` chunks.

### Failures

Every refusal or failure is a `PluginOperationError` with a stable `code` and `details` typed by it: `plugins/unavailable` (no profile runtime, or no roster for a preset target), `plugins/not-installed`, `plugins/not-enableable`, `plugins/enable-failed`, `plugins/install-failed`, `plugins/row-conflict`, `plugins/busy`, `plugins/agents-running`, and `plugins/bad-request` for a request that names nothing the profile has. `pluginOperationFailureOf` narrows a caught value to the code-discriminated union.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### One manifest, two writers

Every change reads the profile manifest afresh and writes it through the same app-boot helpers the `dsh plugin` command's forwarded verbs use (`reconcileInstalledBundles`, `enableBundle`, `disableBundle`), so the CLI and the Web host never disagree on the file. `dependencies` records what is installed; `dsh.profile.bundles` records what is enabled.

### pnpm runs through `node:child_process`

The subprocess seam scrubs secret-shaped variables and has no shell mode, and pnpm needs both the user's registry, proxy, and auth settings and, on Windows, the shell that resolves its `.cmd` shim. The installer therefore spawns pnpm the way the CLI always did, with the parent environment and `shell` on Windows, and streams the child's output itself.

### Retry is disable then enable

The Loader's transactional update leaves an unchanged row alone, so a failed isolated row would not restart on a plain recomposition. Retry takes the bundle out of the layer list and puts it back: two recompositions, and the manifest ends as it began.

### What the manager reads and what it is handed

The manager reads the Loader tree, the reflect store, and the `pluginFailures` registry through the context it is built over. Everything that belongs to another package — the profile runtime, the preset roster, the agent registry — arrives through `PluginManagerOptions` as a reader called per call, and the roster only as `PresetLayers`: the layer path, the preset list, and the composition rows the row operations need. The package therefore depends on app-boot alone, whose `./patch-file` export reads and writes the layers, and on nothing that composes presets or agents.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The package API: re-exports of the classes, options, types, and failure codes |
| [`src/installer.ts`](src/installer.ts) | `PluginInstaller`: pnpm runs with streamed output, the probe record cache, and the post-install checks |
| [`src/manager.ts`](src/manager.ts) | `PluginManager`: every operation over the booted profile, the one-at-a-time mutex, user-layer edits, and dependents |
| [`src/view.ts`](src/view.ts) | The view fold: manifest, probe, and live-tree rows into one `PluginPackageView`, and the row-ownership walk |
| [`src/modules.ts`](src/modules.ts) | Declared `dsh.plugins` modules: row naming, derived row ids, and their wire view |
| [`src/helpers.ts`](src/helpers.ts) | Shared vocabulary: the diagnostic prefix, tooling bounds, the spawn seam, and the manifest readers |
| [`src/types.ts`](src/types.ts) | Payloads, the `plugins/changed` and `plugins/install-log` events, and the `plugins/*` failure codes with their details |
| [`src/errors.ts`](src/errors.ts) | `PluginOperationError` and the code-discriminated failure union |
| — | No runtime invariant companion is published; every view is folded from the manifest, the probe cache, and Loader-owned state on each call. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these when the manager's contract is not enough: the runtime it drives, the files it edits, and the surfaces that call it.

- [App boot](../app-boot/README.md) — the profile runtime, external bundle isolation, and the package probe.
- [Patch files](../app-boot/README.md#patch-files) — how user-layer rows are read and written.
- [Agent presets](../../preset/agent-presets/README.md) — the per-preset user layer a preset target writes.
- [Host plugin manager](../../host/plugin-manager/README.md) — the `plugins` Remote over this manager.
- [dsh app](../../../apps/cli/README.md) — the `dsh plugin` command over the installer.

-----

<a id="model-experience"></a>
## Model Experience

None, as plugin management registers nothing model-facing; the rows it composes own every registration they make.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the manager will not do for a caller. They are current package constraints, not a task backlog.

- **Updating a loaded package needs a restart** — Node caches ESM modules by URL and a hoisted install keeps the path; `pnpm update` through `add` rewrites the files but the running tree keeps the old modules until the process restarts.
- **Dependents stop at injection** — a registry-type dependency (a tool, an LLM adapter) has no `inject` edge, so `dependents` cannot name a row that only reads what the package registered.
- **A preset row is not composed live** — the manager writes the preset's layer; sessions created afterwards compose it, sessions already running keep their generation.
- **No `engines.dsh` check yet** — the range is reported, not enforced against the running harness version.
- **One process at a time** — the mutex is in-process and the patch-file writer takes a file lock, but the profile manifest has no lock: the CLI and a running Web host editing the same profile at once is not supported.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
