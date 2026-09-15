/** Public plugin management records shared with clients. */
import type { PluginInventoryEntry } from '@deepseek-ai/dsh-host-plugin-inventory/types'
export type { PluginEntryId } from '@deepseek-ai/dsh-host-plugin-inventory/types'

/** Reasons a profile control cannot modify its target. */
export type ReadOnlyReason = 'management-required' | 'unaddressable'

/** Localizable management failure and optional external diagnostic. */
export interface ManagementError {
  code: ReadOnlyReason | 'unknown-plugin' | 'invalid-spec' | 'ambiguous-install' | 'not-bundle' | 'not-removable' | 'stop-profile' | 'bundle-in-use' | 'operation-error'
  diagnostic?: string
}

/** One running-profile entry and its persistent control availability. */
export type PluginInfo = PluginInventoryEntry & (
  | { patchId: string; readOnlyReason?: never }
  | { patchId?: never; readOnlyReason: ReadOnlyReason }
)

/** One installed or installation-provided bundle. */
export interface BundleInfo {
  name: string
  version?: string
  enabled: boolean
  removable: boolean
  readOnlyReason?: ReadOnlyReason
  error?: ManagementError
}

/** Pnpm completion, including a retrieval path for unabridged diagnostics. */
export interface PackageResult {
  exitCode: number
  output: string
  truncated: boolean
  logPath: string
}

/** Persisted change and independently observed application outcome. */
export interface ChangeResult {
  changed: boolean
  application: 'applied' | 'restart-required' | 'overridden' | 'failed'
  /** Last attempted step; successful installation can proceed to enablement. */
  stage: 'install' | 'enable' | 'remove'
  target: string
  enabled?: boolean
  error?: ManagementError
  /** Pre-existing inactive entries or diagnostics from inspecting installation leftovers. */
  warnings?: string[]
  /** Newly added dependencies still declared after failed installation cleanup. */
  remainingDependencies?: string[]
  /** One cleanup attempt, restricted to a newly added dependency. */
  cleanup?: { name: string; packageResult?: PackageResult; error?: ManagementError }
  packageResult?: PackageResult
}

/** Bundle installation defaults to activation. */
export interface InstallBundleOptions {
  enabled?: boolean
}
