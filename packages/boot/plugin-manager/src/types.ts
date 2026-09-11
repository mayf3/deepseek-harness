/**
 * Payloads, events, and failure codes of plugin management. Every value here
 * is lossless JSON: the Web host's `plugins` Remote carries them unchanged
 * and the `dsh plugin` command prints them.
 * @module @deepseek-ai/dsh-plugin-manager/types
 */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** What an installed package is: a bundle layer, declared plugin modules, or an unknown package. */
export type PluginPackageKind = 'bundle' | 'plugin' | 'unknown'

/** Who supplied a package: the installation's own bundles, or a dependency the user installed. */
export type PluginPackageTrust = 'builtin' | 'external'

/** Startup failure policy: external runtime rows are optional; boot rows are required. */
export type PluginPackageStage = 'boot' | 'runtime'

/**
 * The state one package is in, folded from the manifest, declarations, and current entries:
 *
 * - `running`: enabled, all enabled rows active, and no current issue;
 * - `partial`: at least one active row, with a failed attempt or unresolved dependency;
 * - `failed`: enabled with no active row, or the requested live layer selection has not been applied;
 * - `disabled`: installed and not in the layer list;
 * - `not-enableable`: bundle declarations cannot be read;
 * - `restart-required`: its manifest state and the live tree disagree, which a profile without live reload resolves at the next start;
 * - `plain`: a bundle-less package; explicitly declared modules can be added to a composition.
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
  /** The current row issue, which can coexist with an active old fiber after an update fails. */
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

}

/** One package as the manager sees it. */
export interface PluginPackageView {
  /** The installed package name. */
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
  /** Whether physical Cordis resolution matches the harness; null when unavailable. */
  readonly cordisSameCopy: boolean | null
  /** The rows the bundle contributes, from the live tree when enabled, else from its static patch. */
  readonly rows: readonly PluginPackageRowView[]
  /** Current issues in owned rows or existing rows this bundle overrides; ownership is unchanged. */
  readonly issues?: readonly PluginRowIssue[]
  /** Ids of built-in rows the bundle's patch overrides. */
  readonly overrides: readonly string[]
  /** Agent-plane modules the package declares addable. */
  readonly addable: readonly PluginPackageAddableView[]
  /** Whether the profile applies user patch files while running; false means changes wait for a restart. */
  readonly liveReload: boolean
}

/** Where a composition row is added or edited: the profile's global user layer, or one preset's. */
export type PluginRowTarget =
  | { readonly kind: 'global' }
  | { readonly kind: 'preset'; readonly preset: string }

/** A package pnpm installed that the run removed again, with the check it failed. */
export interface PluginInstallRejection {
  /** The package name. */
  readonly name: string
  /** Why the bundle was rejected, such as a conflicting row id or invalid stage. */
  readonly reason: string
}

/** What one install run changed. */
export interface PluginInstallResult {
  /** Dependencies present after the run and absent before it that passed the post-install checks, by name. */
  readonly installed: readonly string[]
  /** Dependencies pnpm added that the run removed again, each with its reason. */
  readonly removed: readonly PluginInstallRejection[]
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
  /** Current row issues after a live application; absent when no issues were observed or application waits for restart. */
  readonly issues?: readonly PluginRowIssue[]
}

/** Serializable outcome for an entry whose requested behavior is not fully active. */
export interface PluginRowIssue {
  readonly entryId: string
  readonly moduleName: string
  readonly stage: string
  readonly message: string
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
export type PluginChangeReason = 'install' | 'uninstall' | 'enable' | 'disable' | 'retry' | 'row' | 'runtime'

/** One chunk of an install run's output. */
export interface PluginInstallLogChunk {
  /** The run the chunk belongs to. */
  readonly jobId: string
  /** The command line the run executes: pnpm's command name, then its arguments. */
  readonly argv: readonly string[]
  /** The directory the run executes in: the profile directory. */
  readonly cwd: string
  /** The package spec the run installs or removes. */
  readonly spec: string
  readonly stream: 'stdout' | 'stderr'
  /** The output as pnpm wrote it; with the installer's colours on, its SGR escapes included. */
  readonly text: string
  /** Present on the run's last chunk, with pnpm's exit code (null when it ended by a signal or never started). */
  readonly exitCode?: number | null
}

/**
 * The failure vocabulary of plugin operations: each code with the details a
 * failure of that code carries. The Web host declares the same entries under
 * its Remote failure map, so a client sees the codes unchanged.
 */
export interface PluginOperationDetailsMap {
  /** No profile runtime is composed, so there is no profile to manage. */
  'plugins/unavailable': { readonly reason: string }
  /** The package is not a profile dependency. */
  'plugins/not-installed': { readonly packageName: string }
  /** The package cannot be enabled or added, with the declaration or request error. */
  'plugins/not-enableable': { readonly packageName: string; readonly reason: string }
  /** Preparation or the root Include rejected enablement; the layer selection was reverted. */
  'plugins/enable-failed': { readonly packageName: string; readonly reason: string }
  /** pnpm exited non-zero, could not be spawned, or timed out. */
  'plugins/install-failed': { readonly spec: string; readonly exitCode: number | null; readonly log: string }
  /** The row id is already taken in the target user layer. */
  'plugins/row-conflict': { readonly rowId: string; readonly target: PluginRowTarget }
  /** Another mutation is still running; the manager runs one at a time and refuses rather than queues. */
  'plugins/busy': {
    readonly operation: string
    readonly subject: string
    readonly active: { readonly operation: string; readonly subject: string }
  }
  /** `node_modules` cannot change while a session runs; `running` counts the agents in `running` status. */
  'plugins/agents-running': { readonly operation: string; readonly running: number }
  /** The request names nothing the profile has: an empty spec, a template bundle, a row the layer does not insert. */
  'plugins/bad-request': {}
}

/** Every plugin operation failure code. */
export type PluginOperationCode = keyof PluginOperationDetailsMap

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
