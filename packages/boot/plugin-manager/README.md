---
description: "Plugin management over a dsh profile: the installer the dsh plugin command and the Web host share, and the manager over the booted profile that enables, disables, retries, edits user-layer rows, and reports every package."
kind: "package-reference"
---

# @deepseek-ai/dsh-plugin-manager

English | [中文](README.zh.md)

## Summary

`dsh-plugin-manager` installs packages and manages their declared plugin rows through the CLI and Web host. Installation reads metadata without executing modules. The manager enables whole bundle layers, edits global or preset user patches, retries failures, and reports current runtime issues. Failures carry `plugins/*` codes; the [Host adapter](../../host/plugin-manager/README.md) exposes the operations through Remote.

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

Build a `PluginInstaller` from the profile directory, the install anchor (the dsh app's `package.json`), a `loadProfile` that answers the profile's composed layers, the tooling bounds, a sink for pnpm's output, and whether pnpm colours it; then `add(spec)` or `remove(name)`:

```ts
import { loadProfile } from '@deepseek-ai/dsh-app-boot'
import { PluginInstaller } from '@deepseek-ai/dsh-plugin-manager'

declare const profileDir: string
declare const installAnchor: string

const installer = new PluginInstaller({
  profileDir, profileName: 'web', installAnchor,
  loadProfile: () => loadProfile('dsh', 'web', installAnchor, undefined, { userLayer: false }),
  config: { pnpmCommand: 'pnpm', installTimeoutMs: 600_000, installLogTailBytes: 16_384 },
  installLog: (chunk) => process.stdout.write(chunk.text),
  color: process.stdout.isTTY,
})
const outcome = await installer.add('@acme/dsh-sql-tool')
console.log(outcome.installed, outcome.removed)
```

`add` runs pnpm in the profile, reconciles `dependencies`, and statically checks new bundle declarations against current row ownership. Conflicting bundles are removed with a reason; undeclared and unreadable packages remain installed. New bundles stay disabled unless the caller enables them. A failed pnpm run restores the pre-run manifest and reports `plugins/install-failed` with the log tail.

### Managing the booted profile

Build a `PluginManager` over the Cordis context and readers for what it needs per call — the profile runtime, the preset roster's layers, and the running-agent count — so a composition that gains or lacks one of them is answered at call time rather than at mount:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-app-boot'
import { PluginManager, type PluginToolingConfig } from '@deepseek-ai/dsh-plugin-manager'

declare const ctx: Context
declare const config: PluginToolingConfig

const manager = new PluginManager(ctx, {
  config,
  runtime: () => ctx.get('profileRuntime'),
  presets: () => ctx.get('agentPresets'),
  runningAgents: () => (ctx.get('agents')?.list() ?? []).filter(agent => agent.status === 'running').length,
})
console.log(await manager.list())
```

`list` reports package identity, `bundle` / `plugin` / `unknown` classification, installation and enablement. Runtime rows carry actual phases and failures; disabled bundles show static patch declarations. `addable` comes only from `dsh.plugins`, including `.` for the main export and declared defaults. An active row can retain its previous config after an update fails. Package `issues` also names failed rows its patch overrides, without transferring their ownership.

`enable` selects the whole bundle layer and recomposes live profiles. Per-row failures retain the enabled choice and successful siblings; results report `issues`, and the list can show `partial` or `failed`. Preparation failures revert the enable selection and raise `plugins/enable-failed`. `disable` removes the whole layer, including overrides. `retry` disables, awaits cleanup, and enables again. Startup-only profiles report `effect: restart`. Unapplied selections on live profiles report `failed`, preserving the rows actually running; `restart-required` is reserved for startup-only profiles. `uninstall` disables the bundle, removes user-inserted references, and runs pnpm remove.

`addRow` writes an explicitly declared `dsh.plugins` module to the profile’s global `cordis.patch.yml` or a preset user layer. It preserves declared defaults, checks the target row id, and performs no pre-mount import. `removeRow` removes a user insert. `setRowDisabled` writes or removes `disabled: true`, preserving the bundle’s own condition. Global edits recompose immediately on live profiles; preset edits apply to subsequent generations. `dependents` reports injection dependents and user-layer module references.

The manager runs one mutation at a time — a second call while one runs fails with `plugins/busy` naming the operation in flight — and `add` and `uninstall` refuse to change `node_modules` while a session is running, with `plugins/agents-running`. Every change is followed by a `plugins/changed` event on the context, and an install run emits pnpm's output as `plugins/install-log` chunks, each naming the command line it ran and the profile directory it ran in, and, with colour on, carrying pnpm's SGR escapes.

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

Retry removes the entire layer and awaits removed-fiber cleanup before adding it again. It does not rely on changing a synthetic group or silently compensating for failed plugin effects.

### What the manager reads and what it is handed

The manager reads Loader entries, the reflect store and entry-owned diagnostics. Profile, preset and agent facts arrive through per-call readers. The [Host adapter](../../host/plugin-manager/README.md) converts Loader lifecycle changes into `plugins/changed` notifications after settlement, including a pending row whose provider becomes available.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The package API: re-exports of the classes, options, types, and failure codes |
| [`src/installer.ts`](src/installer.ts) | `PluginInstaller`: pnpm runs with streamed output, static declarations, and the post-install checks |
| [`src/manager.ts`](src/manager.ts) | `PluginManager`: every operation over the booted profile, the one-at-a-time mutex, user-layer edits, and dependents |
| [`src/view.ts`](src/view.ts) | The view fold: manifest, declarations, and live-tree rows into one `PluginPackageView`, and the row-ownership walk |
| [`src/modules.ts`](src/modules.ts) | Declared `dsh.plugins` modules: row naming, derived row ids, and their wire view |
| [`src/helpers.ts`](src/helpers.ts) | Shared vocabulary: the diagnostic prefix, tooling bounds, the spawn seam, and the manifest readers |
| [`src/types.ts`](src/types.ts) | Payloads, the `plugins/changed` and `plugins/install-log` events, and the `plugins/*` failure codes with their details |
| [`src/errors.ts`](src/errors.ts) | `PluginOperationError` and the code-discriminated failure union |
| — | No runtime invariant companion is published; every view is folded from the manifest, static declarations, and Loader-owned state on each call. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these when the manager's contract is not enough: the runtime it drives, the files it edits, and the surfaces that call it.

- [App boot](../app-boot/README.md) — the profile runtime, external bundle isolation, and static package declarations.
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
