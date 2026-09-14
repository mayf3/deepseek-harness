/** Public plugin management records shared with clients. */
import type { PluginInventoryEntry } from '@deepseek-ai/dsh-host-plugin-inventory/types'
export type { PluginEntryId } from '@deepseek-ai/dsh-host-plugin-inventory/types'

/** One running-profile entry and its persistent control availability. */
export interface PluginInfo extends PluginInventoryEntry {
  /** Profile patch target; absent for dynamically mounted or ambiguous entries. */
  patchId?: string
  /** Why the manager cannot modify this entry. */
  readOnlyReason?: string
}

/** One installed or installation-provided bundle. */
export interface BundleInfo {
  name: string
  version?: string
  enabled: boolean
  removable: boolean
  readOnlyReason?: string
  error?: string
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
  message: string
  packageResult?: PackageResult
}

/** Bundle installation defaults to activation. */
export interface InstallBundleOptions {
  enabled?: boolean
}
