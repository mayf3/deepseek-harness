---
description: "Shared Loader boot support for dsh profiles and the temporary Python SDK runtime: environment layers, patches, diagnostics, and configuration preview."
kind: "package-library"
---

# @deepseek-ai/dsh-app-boot

English | [中文](README.zh.md)

## Summary

`dsh-app-boot` is the shared Loader boot library behind `dsh` profiles, including the CLI packaged by the Python runtime wheel. It loads environment layers, composes profile bundles and patches, boots every plugin, and returns the running app or identifies the failed plugin and cause. Product applications use the `dsh` launcher instead of publishing separate bins; direct-config helpers remain only for lower-level embedders and tests. You can preview the effective configuration before booting, select live or startup-only patch application per profile, and let a terminal-owning app restore its terminal before a fatal exit.

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

Starting an app with this package is a small, explicit entry point: you give it a config file and it runs the whole boot. This section covers what you can do and what you get; the helper calls behind each outcome are documented in the folded implementation section.

### When to use it

Use it when implementing the shared `dsh` launcher or embedding its lower-level boot helpers. Product features belong in profile bundles instead of new application bins; code that only adds plugins to an already-running app mounts those plugins directly.

### Starting the app

You give your entry point a config file, and the process starts the whole app: it loads your environment layers, applies patches and profiles, boots every plugin, and returns once the app is running. In replay mode it boots the sibling `cordis.snapshot.yml` instead, so a recorded session reproduces identically. The smallest entry point is two calls:

```text
installFailLoud('dsh')
const ctx = await boot('dsh', resolveConfigPath(argv[2], process.env.DSH_SNAPSHOT))
```

With that entry point, success looks like a running app with every plugin active; failure is never silent — one labelled line names the failing plugin and the stage, and the process exits nonzero. The app context is torn down before the error is reported, so nothing keeps running half-started.

<a id="profiles"></a>
### Profiles

Import profile and bundle declaration types from [`@deepseek-ai/dsh-package-manifest`](../../util/package-manifest/README.md). App-boot owns profile loading, JSON validation, and resolved runtime data.

A profile is how one dsh installation ships different app surfaces: `web`, `headless`, `acp`, `sdk`, and `sdk-minimal` start distinct compositions from the same launcher. A profile lives at `$DSH_HOME/profiles/<name>` and combines installable bundles, its own `cordis.patch.yml`, and `patchReload: live | startup`; omitted reload policy keeps the historical `live` default for custom profiles. The shipped `web` template uses live reload, while the other shipped templates apply patches only at startup. `sdk-minimal` names only its standalone bundle; the other templates retain base-plus-mode stacks. `dsh plugin` creates custom profiles, and a missing bundle or one without a patch declaration fails startup loudly.

Your machine-local preferences also live in the Harness home:

- **`.env`** — your ordinary environment layers: the invoking directory's file outranks the Harness-home file, and both sit below the inherited environment. Variables that decide how the process starts (`PATH`, `DSH_*`, `XDG_*` and similar) are rejected from files: export them instead. The four proxy names (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`) are accepted from the Harness-home file only, never from the invoking directory's, which arrives with a clone. For a non-product bin that just wants one directory's `.env`, a missing file is fine and an unloadable one prints one labelled warning line.
- **`cordis.patch.yml`** — your tweak layer, applied after every bundle layer (per-profile first, then the home-level file, which therefore outranks it): replace one entry's whole config (restating the fields you keep), insert new entries, or interpolate `!!js` expressions at boot. A patch naming an entry that does not exist prints a stderr warning; an empty or comments-only file fails boot — disable the layer with `[]` instead.

Profiles with `patchReload: live` watch both user patch files: a valid edit recomposes without restart, while a rejected edit leaves the last good app running. A `startup` profile installs neither those watchers nor the launcher's watch-only HMR fallback.

Inserted plugin names may be absolute filesystem paths, file URLs, or package specifiers. Patch loading converts absolute paths and patch-relative `./` or `../` paths to file URLs within `insert` rows and their nested groups; existing-entry name assertions and replacement `config` values remain literal.

A bundle you installed with `dsh plugin` is an **external** bundle: its rows mount under one contained group named `bundle/<package>` with the ids its patch declares, and a row that fails to start is isolated and recorded instead of stopping the process — the group and its other rows stay up, and the plugin list shows the failure. Template bundles are built in and keep failing loud. A bundle that provides a service built-in rows inject must mount like a built-in one: its author declares `dsh.bundle.stage: boot` in `package.json`, or you set `dsh.profile.stages` in the profile manifest, which wins. Even without that, an isolated failure that leaves a built-in row waiting for a service still stops the boot and names the isolated bundle. Two more profile-manifest fields shape this: `dsh.profile.firstParty` lists installed packages treated as built in (a first-party package linked in during development), and `dependencies` versus `dsh.profile.bundles` distinguishes a package that is merely installed from one whose layer is enabled. Row ids share one namespace across the stack: built-in layers own theirs first, an external bundle that declares an id another layer already owns, or declares one of its own ids twice, is left out whole and reported on stderr and in the plugin list, and a user-layer insert of a taken id is dropped and reported the same way.

After the tree is up the launcher provides `ctx.profileRuntime`, which holds the composition the tree runs — the profile, the installation anchor, the layer that owns each row, and the rows the composition left out — reads which rows the user patch files disable, and is the one entry point that recomposes the tree: the patch watchers and the [plugin manager](../../host/plugin-manager/README.md), enabling or retrying a bundle, all call it, and a rejected update leaves its facts describing the tree still running; `recordContainedStates` is what such a caller runs afterwards, because the boot audit does not run again. Startup's fail-loud rejection guard is uninstalled once the tree is up: an unhandled rejection after boot is reported and the process keeps running, with nothing stopped or attributed to a plugin; an uncaught exception is reported and exits.

### Previewing the effective configuration

Before you boot, you can print the exact configuration the app will mount: the dump shows the composed entry list with `!!js` expressions verbatim, grouped under comments naming each source file and the patch layers that changed it, as one loadable YAML document. Patches that match no row are reported with their layer label; a missing, unparsable, or invalid config fails the dump.

### What you see when startup fails

Startup failure is a single labelled line plus a nonzero exit — never a silent hang or a raw stack dump. The message names the failing plugin; a plugin that threw keeps its original error, and an entry that never started is reported with the services it was waiting for.

If your app owns the terminal, it can hand the terminal back before the process exits, so your shell is never left in raw mode. The handoff is bounded: a stuck cleanup delays the fatal exit but never cancels it.

### Telling the agent where the harness lives

When your app boots a model-backed agent, you can tell the agent where the DSH implementation checkout lives: it learns that path and that it must not infer the working directory from it — it should use `pwd`. The instruction appears once near the top of the system prompt. Apps without a system prompt service skip it; in development, reloading the system prompt drops it until the next boot.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the outcomes above are realized and points at the code that realizes them; everything here is developer-facing and not needed to use the package.

### Design notes

- **Channel-neutral library.** The package carries no loader hooks and no dev-mode surface; the [`dsh` app](../../../apps/cli/README.md) owns its Node source-launch hook and consumes these helpers for the boot sequence, and built consumers use plain Node package resolution.
- **Three Loader builtins.** `mountRootInclude` registers `cordis:include`, `cordis:group`, and `cordis:contained-group` as Loader builtins: a group row gives one `isolate` realm to a provider and its consumers together, an agent preset outside this workspace cannot resolve `@deepseek-ai/cordis-plugin-group` by name, and the contained group is where external bundles mount. All load through the ambient module pipeline rather than the included tree's own specifier resolution.
- **External bundles are groups.** The vendored `EntryGroup.update` is all-or-nothing, so `composeExternalLayer` wraps each `runtime`-stage external layer's inserts in one `cordis:contained-group` under the ids the bundle declares; the group's `create()` records a failed row on the root's `pluginFailures` registry instead of rejecting, a group that unmounts drops its rows' records, and `assertEntriesActivated` exempts recorded rows while still failing a built-in row left pending.
- **Row ids are owned, not rewritten.** Entry ids are unique per tree and a `create()` that finds an existing id re-parents that entry instead of rejecting, so `composeProfileStack` decides ownership before anything mounts: built-in and boot-staged layers claim first and a duplicate among them fails the boot, a contained bundle that collides is left out whole, a user insert of a taken id is dropped, and every such row is a `conflict` record in `pluginFailures`. Boot, live recomposition, and `--dump-config` compose through the same function.
- **Fail-loud is boot-scoped.** `installFailLoud` exits on any unhandled rejection because during startup one is a load failure; the launcher uninstalls it once the tree is up and installs `installRuntimeGuards`, which reports a rejection and keeps running and exits on an uncaught exception. Nested fibers (a `ctx.inject()` continuation) that fail under a built-in entry are reported by `warnNestedFiberFailures` as advisory lines.
- **The probe never runs a package in the host.** `probePackage` reads an installed package's manifest here and imports it in a child process that reports over an IPC channel, so a package that throws, exits, hangs, prints at import, or brings its own copy of cordis costs one child and yields a record with the reason; the child's report and the cached record are validated field by field before either is trusted. It calls a package a `plugin` only when the package declares itself to dsh — a `dsh` section or a dependency on `@deepseek-ai/cordis` — and its main export is plugin-shaped; a bare function export (`lodash`) is a `library`. Records are cached under the profile's `.dsh-plugins/` with a format number, so a record an older probe wrote is probed again rather than trusted.
- **Profile module fallback.** Bare plugin specifiers resolve through the Loader from the config directory. Plain Node maintains one symlink per package in the installation dependency closure. A packaged executable instead reads each installed export map with Node ESM conditions and writes real proxy packages that re-export virtual module URLs, because an operating-system symlink cannot enter pkg's `/snapshot` tree. Missing exports stay unavailable, malformed maps fail startup, and a cross-process writer lock replaces stale entries without exposing partial proxies. A selected external bundle absent from the installation closure receives a profile-local `.dsh-module-fallback` link; existing pnpm entries win, projected links are excluded from later closure discovery, and cleanup removes only dsh-owned links.
- **One rejection checkpoint.** `assertEntriesActivated` keeps the exact reasons it folds into the boot diagnostic visible through the next process rejection checkpoint, so `installFailLoud` coalesces Loader's duplicate notification while unrelated unhandled rejections remain fatal.
- **Two-stage failure labels.** `boot()` distinguishes `host preparation failed` — `prepare` threw before any config-tree entry mounted — from `plugin tree failed to load`, and appends the deepest plugin error's stack so the startup diagnostic preserves the original activation error instead of only the wrap chain.

### Helper behavior

The exports each own one stage of the boot: config resolution and snapshot replay, layered environment loading, fail-loud reporting, activation auditing, patch parsing, root-include mounting, config dump rendering, live patch watching, profile composition, and the harness-source section. Per-export contracts live in the code, not this README — see [`src/index.ts`](src/index.ts) and [`src/profile.ts`](src/profile.ts).

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Boot helpers: config resolution, environment loading, fail-loud guard and runtime guards, activation audit and `recordContainedStates`, patch-file loading through `dsh-patch-file`, config dump, harness-source section |
| [`src/profile.ts`](src/profile.ts) | Profile discovery, initialization, bundle resolution with `layerTrust` and stage, module fallback |
| [`src/external-bundles.ts`](src/external-bundles.ts) | External layer composition (contained group, overrides), `bundleLayerPatches`, and the manifest operations behind install, enable, and disable |
| [`src/compose-stack.ts`](src/compose-stack.ts) | Row-id ownership across the stack: `claimLayerIds`, `composeProfileStack`, conflict records |
| [`src/contained-group.ts`](src/contained-group.ts) | The `cordis:contained-group` builtin and the `pluginFailures` registry |
| [`src/profile-runtime.ts`](src/profile-runtime.ts) | The `profileRuntime` service: the committed composition (profile, row provenance, conflicts), user-disabled rows, recomposition |
| [`src/probe.ts`](src/probe.ts) | The package probe and its per-profile cache; [`src/probe-child.ts`](src/probe-child.ts) is the child entry it spawns and [`src/probe-report.ts`](src/probe-report.ts) the report it validates |
| — | No runtime invariant companion is published; this presentation adapter owns no durable package-local event stream; boundary and replay tests cover its protocol mapping. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared boot mechanics to the composition model and the decision evidence behind it.

- [Cordis primer](../../../docs/cordis-primer.md) — Loader, `!!js` config expressions, and include/group semantics.
- [dsh app](../../../apps/cli/README.md) — the `dsh` bin that consumes these helpers.
- [dsh-cmdline](../cmdline/README.md) — the launcher-to-app command-line handoff the bins use.
- [Profile bundles](../../bundle/README.md) — installable patch layers composed into `dsh --profile`.
- [dsh-home-paths](../../util/home-paths/README.md) — the Harness-home resolver (`resolveDshHome`).
- [Configuration source ownership](../../../.agents/notes/implemented/architecture/2026-08-04-configuration-source-ownership.md) — why a discovered file may not decide bootstrap behavior.
- [Profile plugin bundles](../../../.agents/notes/implemented/architecture/2026-08-05-profile-plugin-bundles.md) — the profile and bundle composition design.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the loaded plugin tree, which alone contributes model context; the one export that adds model-visible text, `addHarnessSourceSection`, does so only when a consumer calls it after boot.

#### KV Cache effect

Boot itself invalidates nothing in the request prefix. A consumer that calls `addHarnessSourceSection` places one short line near the system prompt's head, before per-request content, so it does not invalidate the cache across turns; any other request-prefix change is owned by the named consumer.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits describe when this boot library is a poor fit or needs special care. They are current package constraints, not a task backlog.

- **Bare package specifiers depend on Loader internals** — production bins need Loader's optional native helper; an in-process caller without it must use resolvable relative/file specifiers or provide its own module-resolution hook.
- **Snapshot replay swapping is basename-specific** — only a config ending in `cordis.yml` or `cordis.yaml` maps to the sibling `cordis.snapshot.yml`; custom config names require caller-managed selection.
- **Environment discovery is launch-scoped** — `loadLayeredEnv` reads only the invocation directory and Harness home once; it does not search parents or follow a workspace selected later. `loadEnv` remains the one-directory helper for non-product bins.
- **A user patch replaces the whole matched config** — an id-targeted patch does not deep-merge, so a profile override restates the bundle fields it keeps.
- **An external bundle's overrides are not isolated** — a patch it applies to a built-in row edits that row in place, so its effect stays when the bundle's own rows fail and it is the one thing a bundle can break outside its group.
- **A conflict is decided by order, not merit** — among external bundles the earlier layer in `dsh.profile.bundles` keeps a contested id, so uninstalling that bundle lets the later one mount on the next boot; the plugin list shows which bundle lost and to whom.
- **The nested-fiber audit is advisory** — a failed `ctx.inject()` continuation under a built-in entry is reported, not fatal, until shipped compositions are known clean.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open design questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

#### Open: config dump stability

`renderConfigDump` output is a loadable YAML document whose `# ==` provenance comments and `!!js`-verbatim rendering serve the `--dump-config` diagnostic. Nothing promises byte stability across package versions; decide whether the dump becomes a serialization contract before anything consumes it programmatically.

</details>
