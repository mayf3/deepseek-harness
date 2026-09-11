import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable Loader-tree identity of one configured plugin entry. */
export type PluginEntryId = Branded<'PluginEntryId'>

/** Lifecycle state of an entry's root Fiber, or null when it has no live root Fiber. */
export type PluginFiberPhase =
  | 'pending'
  | 'loading'
  | 'active'
  | 'failed'
  | 'unloading'
  | null

/**
 * Who supplied a Loader row: the installation itself, an installed external
 * bundle, or the user's own patch file (a row of theirs the composition left out).
 */
export type PluginTrust = 'builtin' | 'external' | 'user'

/** Why a row is disabled: the composition's own gate or tombstone, or the user's patch layer. */
export type PluginDisabledBy = 'composition' | 'user'

/** The package a row belongs to, when a bundle layer inserted it. */
export interface PluginPackageRef {
  /** The bundle's package name. */
  readonly name: string
  /** The package version, when its manifest declares one. */
  readonly version?: string
}

/** A current entry failure or unresolved dependency, or a row the composition left out. */
export interface PluginFailure {
  /** The lifecycle step that failed; `conflict` is a row another layer already declares. */
  readonly stage: 'import' | 'activation' | 'update' | 'disabled-expression' | 'inject-pending' | 'conflict'
  /** The failure text. */
  readonly message: string
}

/** One non-group Loader entry exposed to trusted clients. */
export interface PluginInventoryEntry {
  readonly entryId: PluginEntryId
  /** Exact module specifier imported by the Loader entry. */
  readonly moduleName: string
  /** Effective Loader enablement, including disabled ancestor groups. */
  readonly enabled: boolean
  readonly fiberPhase: PluginFiberPhase
  /** Who supplied the row; `builtin` when no profile runtime is composed. */
  readonly trust: PluginTrust
  /** The bundle package that inserted the row, when one did. */
  readonly package?: PluginPackageRef
  /** Present exactly when `enabled` is false. */
  readonly disabledBy?: PluginDisabledBy
  /** Present for a failed attempt or unresolved dependency, including updates that leave an old fiber active. */
  readonly failure?: PluginFailure
}

/** Effective enablement of one preset composition row. */
export type PresetPluginEnablement = boolean | 'conditional'

/** One plugin row an agent preset's composition names. */
export interface AgentPresetPluginRow {
  /** Composition row id, or null when the row declares none. */
  readonly entryId: string | null
  /** Module specifier the row names. */
  readonly moduleName: string
  /**
   * Effective enablement, including disabled ancestor groups. `'conditional'`
   * marks a `!!js` disabled expression on a composition no session has
   * mounted, which only a Loader context can decide.
   */
  readonly enabled: PresetPluginEnablement
  /** The row's own `!!js` disabled expression, when it carries one. */
  readonly condition?: string
  /** Root-fiber phase when the composition is live; null otherwise. */
  readonly fiberPhase: PluginFiberPhase
  /** Whether the preset's composition file or its user patch layer supplied the row. */
  readonly source: 'preset' | 'user'
  /** Present exactly when `enabled` is false: the composition's own gate, or the user patch layer. */
  readonly disabledBy?: PluginDisabledBy
}

/** One agent preset's identity and flattened composition in the inventory. */
export interface AgentPresetPluginGroup {
  /** Stable preset id. */
  readonly id: string
  /** Whether the deployment ships the preset or the user owns it. */
  readonly trust: 'system' | 'user'
  /** Display name the preset published; a reader falls back to the id. */
  readonly name?: string
  /** Whether a session naming no preset composes this one. */
  readonly isDefault: boolean
  /** Why this preset's composition cannot be read; absent when rows answer. */
  readonly broken?: string
  /** Plugin rows in composition order; empty when the preset is broken. */
  readonly rows: readonly AgentPresetPluginRow[]
}

/** Point-in-time inventory returned by the plugin inventory Remote. */
export interface PluginInventorySnapshot {
  readonly entries: readonly PluginInventoryEntry[]
  /**
   * Per-preset compositions, present only when an agent-preset roster is
   * composed in this deployment.
   */
  readonly agentPresets?: readonly AgentPresetPluginGroup[]
}
