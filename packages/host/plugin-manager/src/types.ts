/**
 * Client-safe payloads, events, and failure codes of the plugin manager.
 * Every value here crosses the Typert wire as lossless JSON.
 * @module @deepseek-ai/dsh-host-plugin-manager/types
 */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** What an installed package is: a bundle layer, a plugin module, or a plain library. */
export type PluginPackageKind = 'bundle' | 'plugin' | 'library'

/** Who supplied a package: the installation's own bundles, or a dependency the user installed. */
export type PluginPackageTrust = 'builtin' | 'external'

/** When a bundle's rows mount: isolated at `runtime` (the default), or with the built-in rows at `boot`. */
export type PluginPackageStage = 'boot' | 'runtime'

/**
 * The state one package is in, folded from the profile manifest, the probe
 * record, and the live tree:
 *
 * - `running`: enabled and every row active;
 * - `partial`: enabled with at least one row failed or waiting;
 * - `failed`: enabled and no row active;
 * - `disabled`: installed and not in the layer list;
 * - `not-enableable`: installed but the probe refused it (import failure, foreign cordis copy);
 * - `restart-required`: its manifest state and the live tree disagree, which a profile without live reload resolves at the next start;
 * - `plain`: a library or plugin module, which is added to a composition rather than enabled.
 */
export type PluginPackageStatus =
  | 'running'
  | 'partial'
  | 'failed'
  | 'disabled'
  | 'not-enableable'
  | 'restart-required'
  | 'plain'

/** Lifecycle phase of a row's root fiber; null when the row has no live fiber. */
export type PluginRowPhase = 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null

/** One row a bundle contributes to the host tree, as the tree runs it. */
export interface PluginPackageRowView {
  /** The row's tree-wide id, as `Entry.id` spells it (`include:<row id>` under the root include). */
  readonly entryId: string
  /** The row id as the composition declares it — what a user patch or a row action targets. */
  readonly rowId: string
  /** Module specifier the row names. */
  readonly moduleName: string
  /** Effective enablement, including a disabled owning group. */
  readonly enabled: boolean
  /** Present exactly when `enabled` is false. */
  readonly disabledBy?: 'user' | 'composition'
  /** Root-fiber phase, or null when the row has no live fiber. */
  readonly phase: PluginRowPhase
  /** The recorded startup failure of an isolated row, when one is recorded. */
  readonly failure?: { readonly stage: string; readonly message: string }
}

/** One agent-plane module a package declares addable to a composition. */
export interface PluginPackageAddableView {
  /** The module as it is named in a row: the bare package for `.`, else `<package>/<subpath>`. */
  readonly moduleName: string
  /** The `dsh.plugins[].name` the package declared. */
  readonly declaredName: string
  /** Display title, when declared. */
  readonly title?: string
  /** Default row config, when declared. */
  readonly config?: JsonValue
  /** Whether the probe imported the module and found a plugin. */
  readonly ok: boolean
  /** The probe's import failure, when `ok` is false. */
  readonly error?: string
  /** The module's `Config` schema envelope, when it declares one. */
  readonly configSchema?: JsonValue
}

/** One package as the manager sees it. */
export interface PluginPackageView {
  /** The package name; also the row-id prefix and group id of an isolated bundle. */
  readonly name: string
  /** The installed version, when the manifest declares one. */
  readonly version?: string
  /** Display title from `dsh.title`, when declared. */
  readonly title?: string
  /** Free text from the manifest. */
  readonly description?: string
  readonly kind: PluginPackageKind
  readonly trust: PluginPackageTrust
  readonly stage: PluginPackageStage
  /** Whether the package is a profile dependency (installed by `dsh plugin add` or the manager). */
  readonly installed: boolean
  /** Whether the bundle is in the profile's layer list. */
  readonly enabled: boolean
  readonly status: PluginPackageStatus
  /** Why the package cannot be enabled, or why it is not running, when the status calls for one. */
  readonly reason?: string
  /** The harness version range the package declares in `engines.dsh`. */
  readonly enginesDsh?: string
  /** Whether the package shares the harness's cordis copy; null when the probe could not tell. */
  readonly cordisSameCopy: boolean | null
  /** The rows the bundle contributes, from the live tree when enabled, else from the probe. */
  readonly rows: readonly PluginPackageRowView[]
  /** Ids of built-in rows the bundle's patch overrides. */
  readonly overrides: readonly string[]
  /** Agent-plane modules the package declares addable. */
  readonly addable: readonly PluginPackageAddableView[]
  /** ISO time of the probe record this view was folded from, when one exists. */
  readonly probedAt?: string
  /** Whether the profile applies user patch files while running; false means changes wait for a restart. */
  readonly liveReload: boolean
}

/** Where a composition row is added or edited: the profile's global user layer, or one preset's. */
export type PluginRowTarget =
  | { readonly kind: 'global' }
  | { readonly kind: 'preset'; readonly preset: string }

/** What one install run changed. */
export interface PluginInstallResult {
  /** Dependencies present after the run and absent before it, by name. */
  readonly installed: readonly string[]
  /** Bundles newly enabled, when the caller asked for it. */
  readonly enabled: readonly string[]
  /** Newly installed bundles left disabled. */
  readonly installedOnly: readonly string[]
  /** Newly installed dependencies that declare no bundle. */
  readonly plain: readonly string[]
  /** The identifier the run's `plugins/install-log` chunks carried. */
  readonly jobId: string
}

/** What enabling a package did. */
export interface PluginEnableResult {
  /** Whether the layer list changed. */
  readonly changed: boolean
  /** `live` when the tree was recomposed, `restart` when the profile applies changes at its next start. */
  readonly effect: 'live' | 'restart'
}

/** One row outside a package that injects a service one of its rows provides. */
export interface PluginServiceDependent {
  /** The service name. */
  readonly service: string
  /** The package row providing it. */
  readonly providedBy: string
  /** Rows outside the package whose fiber injects it. */
  readonly injectedBy: readonly string[]
}

/** One user-layer row that names a module of the package. */
export interface PluginRowReference {
  readonly target: PluginRowTarget
  readonly rowId: string
  readonly moduleName: string
}

/** What disabling or uninstalling a package would strand. */
export interface PluginDependents {
  readonly services: readonly PluginServiceDependent[]
  readonly references: readonly PluginRowReference[]
}

/** Where a row was added. */
export interface PluginRowAddition {
  readonly target: PluginRowTarget
  /** The id the row was given. */
  readonly rowId: string
  /** The user layer file the row was written to. */
  readonly file: string
}

/** Why the manager changed something, for a listener deciding what to refresh. */
export type PluginChangeReason = 'install' | 'uninstall' | 'enable' | 'disable' | 'retry' | 'row'

/** One chunk of an install run's output. */
export interface PluginInstallLogChunk {
  /** The run the chunk belongs to. */
  readonly jobId: string
  /** The package spec the run installs or removes. */
  readonly spec: string
  readonly stream: 'stdout' | 'stderr'
  readonly text: string
  /** Present on the run's last chunk, with pnpm's exit code (null for a signal). */
  readonly exitCode?: number | null
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** No profile runtime is composed, so there is no profile to manage. */
    'plugins/unavailable': { readonly reason: string }
    /** The package is not a profile dependency. */
    'plugins/not-installed': { readonly packageName: string }
    /** The package cannot be enabled or added, with the probe's reason. */
    'plugins/not-enableable': { readonly packageName: string; readonly reason: string }
    /** Enabling composed the bundle and the tree rejected it; the layer list was restored. */
    'plugins/enable-failed': { readonly packageName: string; readonly reason: string }
    /** pnpm exited non-zero. */
    'plugins/install-failed': { readonly spec: string; readonly exitCode: number | null; readonly log: string }
    /** The row id is already taken in the target user layer. */
    'plugins/row-conflict': { readonly rowId: string; readonly target: PluginRowTarget }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * The manager changed what is installed, enabled, or composed.
     * @mode emit
     * @param change - why, and which package when one is concerned.
     */
    'plugins/changed'(change: { readonly reason: PluginChangeReason; readonly packageName?: string }): void
    /**
     * One chunk of an install run's output, in order; the last chunk carries the exit code.
     * @mode emit
     * @param chunk - the chunk.
     */
    'plugins/install-log'(chunk: PluginInstallLogChunk): void
  }
}

export {}
