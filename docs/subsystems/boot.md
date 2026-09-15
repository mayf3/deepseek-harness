# Profile management

English | [中文](boot.zh.md)

The [boot package group](../../packages/boot/README.md) owns launcher-provided profile access and the plugin manager. [Plugin Manager](../../packages/boot/plugin-manager/README.md) documents persistence, reload and package-operation behavior.

## Management records

`PluginEntryId` identifies one Loader entry; callers obtain it from `listPlugins` rather than constructing a patch id.

`PluginInfo` carries module identity, effective enablement and fiber phase, plus a unique `patchId` or a `readOnlyReason`.

`BundleInfo` carries the package name, optional installed version, title and description, whether the profile's own dependencies hold it, selected enablement, removal availability, optional resolution error, the rows its patch declares (`BundleRowInfo`: row id, module, and the live entry id while the bundle contributes it), and the ids of existing rows its patch overrides.

`InstallBundleOptions.enabled` defaults to true. False installs without selecting the bundle layer. `requestId` (`PluginInstallRequestId`, a caller-generated UUID) identifies the installation for its log and state events and for `cancelInstall`, which answers a `PluginInstallCancellation`: `cancelled`, `too-late`, or `not-running`.

`PluginSpecInspection` is what `inspect` answers before an install: an accepted spec's form, name, version, description, title, and bundle declaration, or a refusal's problem and reason.

`PluginInstallLogChunk` is one chunk of a pnpm run's output under its request id and job id, with the command line, the directory, the stream, and the exit code on the run's last chunk; `PluginInstallProgress` is an installation's request id and Host phase; `PluginChange` names the operation behind a `plugin-manager/changed` event, or `reload` for a patch generation applied outside the manager.

`ChangeResult.changed` reports a disk edit independently of `application`: `applied`, `restart-required`, `overridden`, `failed` or `cancelled`. `message` describes the result. Optional `packageResult` records the pnpm exit code, bounded output, truncation flag, complete diagnostic log path, and the failure kind of a failed run; optional `bundle` names the package an installation added.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxhmr--hmr"></a>

### `ctx.hmr` — `Hmr`

Hot reload service with Cordis-compatible module configuration and events.

```ts cordis-catalog
/** Serialize a caller-owned mutation with all automatic reload paths.
 * @param operation Work that must not overlap module or configuration replacement.
 * @returns The operation result after its asynchronous work completes.
 */
runExclusive<T>(operation: () => Promise<T>): Promise<T>

/** Watch a configuration path through the same queue as module replacement.
 * @param filename Absolute path, which may not exist yet.
 * @param refresh Rebuilds configuration from its current files and awaits Loader completion.
 * @returns Disposer closing this registration and waiting for its pending refresh.
 */
async watchConfig(filename: string, refresh: () => Promise<void>): Promise<() => Promise<void>>

/** Read direct module dependency URLs from the active Node loader.
 * @param url Module URL.
 * @returns Linked module URLs, or an empty list for an uncached module.
 */
async getLinked(url: string): Promise<string[]>
```

Source: [`packages/boot/hmr/src/index.ts`](../../packages/boot/hmr/src/index.ts)

<a id="ctxpluginmanager--pluginmanager"></a>

### `ctx.pluginManager` — `PluginManager`

Manage profile files and apply their declared reload lifecycle.

```ts cordis-catalog
/** Read current plugins, including why a row cannot be changed through the profile patch.
 * @returns Current runtime entries with persistent patch targets.
 */
@Remote async listPlugins(): Promise<PluginInfo[]>

/** Read the profile's installed bundles, the bundles this dsh installation supplies, and the selected names that are not bundles.
 * A dependency without a bundle patch is listed, as a `not-bundle` problem, only while it is selected.
 * @returns Package versions, titles, one-liners, rows, activation selections, whether the installation offers the
 * bundle, and removal availability.
 */
@Remote listBundles(): Promise<BundleInfo[]>

/** Read what a spec names before installing it.
 * @param spec One package spec: a registry name, an absolute path, a git address, or a tarball.
 * @param signal Ends a registry lookup early.
 * @returns The package the spec names, or why it is refused.
 */
@Remote async inspect(spec: string, signal?: AbortSignal): Promise<PluginSpecInspection>

/** Persist a plugin entry's desired enablement and apply it on live profiles.
 * @param id Loader entry identity returned by listPlugins.
 * @param enabled Whether the plugin should run.
 * @returns Saved and runtime outcomes, including higher-priority overrides.
 */
@Remote setPluginEnabled(id: PluginEntryId, enabled: boolean): Promise<ChangeResult>

/** Select or remove a bundle layer while retaining installed dependencies.
 * @param name Bundle package name.
 * @param enabled Whether the bundle contributes its patch layer.
 * @returns Persisted and runtime outcomes.
 */
@Remote setBundleEnabled(name: string, enabled: boolean): Promise<ChangeResult>

/**
 * Install a package using the same pnpm implementation as dsh plugin. A run
 * that fails, is cancelled, or adds a package without a bundle patch restores
 * `package.json` and `pnpm-lock.yaml` as they were; downloaded files can stay.
 * @param spec One package spec, including local paths relative to the invocation directory.
 * @param options Whether to activate the installed bundle (defaults to true) and the request id a cancellation names.
 * @returns Package-manager diagnostics and observed activation outcome.
 */
@Remote installBundle(spec: string, options?: InstallBundleOptions): Promise<ChangeResult>

/** Stop an installation this manager owns and wait until its files are back.
 * @param requestId The id the installation was started with.
 * @returns `cancelled` once pnpm exited and the files are restored, `too-late` once the bundle is being
 * applied, `not-running` for any other id.
 */
@Remote async cancelInstall(requestId: PluginInstallRequestId): Promise<PluginInstallCancellation>

/** Unload and remove a profile-owned bundle dependency through dsh plugin's pnpm path.
 * @param name Installed dependency name.
 * @returns Removal diagnostics and the remaining profile state.
 */
@Remote removeBundle(name: string): Promise<ChangeResult>
```

Source: [`packages/boot/plugin-manager/src/index.ts`](../../packages/boot/plugin-manager/src/index.ts)

<a id="ctxprofilecontext--profilecontext"></a>

### `ctx.profileContext` — `ProfileContext`

Current profile facts; scheduling and mutation belong to their callers.

Source: [`packages/boot/app-boot/src/profile-context.ts`](../../packages/boot/app-boot/src/profile-context.ts)

<a id="hmr-events"></a>

### `hmr/*` events

<a id="hmrchange--emit"></a>

#### `hmr/change` — emit

A watched file has no module or configuration handler.

```ts cordis-catalog
/** A watched file has no module or configuration handler.
 * @mode emit
 * @param url Canonical file URL.
 */
'hmr/change'(url: string): void
```

Source: [`packages/boot/hmr/src/index.ts`](../../packages/boot/hmr/src/index.ts)

<a id="hmrreload--emit"></a>

#### `hmr/reload` — emit

Module replacements have finished loading.

```ts cordis-catalog
/** Module replacements have finished loading.
 * @mode emit
 * @param reloads Replaced plugins and their module locations.
 */
'hmr/reload'(reloads: Map<Plugin, Reload>): void
```

Source: [`packages/boot/hmr/src/index.ts`](../../packages/boot/hmr/src/index.ts)

<a id="plugin-manager-events"></a>

### `plugin-manager/*` events

<a id="plugin-managerchanged--emit"></a>

#### `plugin-manager/changed` — emit

The profile's plugins, bundles, or composition changed: a manager operation completed, or a patch generation was applied.

```ts cordis-catalog
/**
 * The profile's plugins, bundles, or composition changed: a manager
 * operation completed, or a patch generation was applied.
 * @mode emit
 * @param change - what changed.
 */
'plugin-manager/changed'(change: PluginChange): void
```

Source: [`packages/boot/plugin-manager/src/types.ts`](../../packages/boot/plugin-manager/src/types.ts)

<a id="plugin-managerinstall-log--emit"></a>

#### `plugin-manager/install-log` — emit

One chunk of a pnpm run's output, streamed as the run produces it.

```ts cordis-catalog
/**
 * One chunk of a pnpm run's output, streamed as the run produces it.
 * @mode emit
 * @param chunk - the chunk and the run it belongs to.
 */
'plugin-manager/install-log'(chunk: PluginInstallLogChunk): void
```

Source: [`packages/boot/plugin-manager/src/types.ts`](../../packages/boot/plugin-manager/src/types.ts)

<a id="plugin-managerinstall-state--emit"></a>

#### `plugin-manager/install-state` — emit

An installation moved between its Host phases.

```ts cordis-catalog
/**
 * An installation moved between its Host phases.
 * @mode emit
 * @param progress - the installation's request id and phase.
 */
'plugin-manager/install-state'(progress: PluginInstallProgress): void
```

Source: [`packages/boot/plugin-manager/src/types.ts`](../../packages/boot/plugin-manager/src/types.ts)

<a id="profile-events"></a>

### `profile/*` events

<a id="profilereconciled--emit"></a>

#### `profile/reconciled` — emit

A complete patch generation was applied to the root Include and the Loader settled, whether or not every row activated.

```ts cordis-catalog
/**
 * A complete patch generation was applied to the root Include and the
 * Loader settled, whether or not every row activated.
 * @mode emit
 * @param patches - the ordered patch list that was applied.
 */
'profile/reconciled'(patches: readonly PatchOptions[]): void
```

Source: [`packages/boot/app-boot/src/index.ts`](../../packages/boot/app-boot/src/index.ts)
<!-- END GENERATED cordis-surface -->
