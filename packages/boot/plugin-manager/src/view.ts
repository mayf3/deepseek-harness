/**
 * The view fold: one package's manifest facts, static declarations, and live-tree
 * rows folded into the `PluginPackageView` the manager lists, plus the row
 * ownership walk the dependents query shares.
 * @module @deepseek-ai/dsh-plugin-manager/view
 */

import type { Context, FiberState } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import { rootIncludeEntry, type EntryIssue, type PackageMetadata, type ProfileManifest, type ProfileRuntime } from '@deepseek-ai/dsh-app-boot'
import { bundlesOf, dependenciesOf, messageOf, optional } from './helpers.ts'
import type { PluginInstaller } from './installer.ts'
import type { PluginPackageRowView, PluginPackageStatus, PluginPackageView, PluginRowPhase } from './types.ts'

/** Runtime mirror: FiberState is a cross-package const enum. */
const FIBER_STATE = {
  PENDING: 0 as FiberState.PENDING,
  LOADING: 1 as FiberState.LOADING,
  ACTIVE: 2 as FiberState.ACTIVE,
  FAILED: 3 as FiberState.FAILED,
  DISPOSED: 4 as FiberState.DISPOSED,
  UNLOADING: 5 as FiberState.UNLOADING,
} as const

/** Complete projection of Cordis Fiber states onto the row phase vocabulary. */
const ROW_PHASE = {
  [FIBER_STATE.PENDING]: 'pending',
  [FIBER_STATE.LOADING]: 'loading',
  [FIBER_STATE.ACTIVE]: 'active',
  [FIBER_STATE.FAILED]: 'failed',
  [FIBER_STATE.DISPOSED]: null,
  [FIBER_STATE.UNLOADING]: 'unloading',
} as const satisfies Record<FiberState, PluginRowPhase>

/** Fields of one row's package ownership a package view needs. */
export interface RowFacts {
  readonly entry: Entry
  readonly rowId: string
}

/**
 * Fold one package's manifest, declarations, and tree facts into its view.
 * @param ctx - the context whose Loader tree and current entry diagnostics the rows come from.
 * @param runtime - the booted profile.
 * @param installer - the installer over the same profile, for static declarations and the installed manifest.
 * @param manifest - the profile manifest, read once per list.
 * @param name - the package.
 * @param allIssues - issues observed once for this list request.
 * @returns the view.
 */
export function packageView(
  ctx: Context,
  runtime: ProfileRuntime,
  installer: PluginInstaller,
  manifest: ProfileManifest,
  name: string,
  allIssues: readonly EntryIssue[],
): PluginPackageView {
  const installed = name in dependenciesOf(manifest)
  const enabled = bundlesOf(manifest).includes(name)
  const layer = runtime.layers.find(candidate => candidate.packageName === name)
  const liveReload = runtime.patchReload === 'live'
  let metadata: PackageMetadata | undefined
  let metadataFailure: string | undefined
  if (installed) {
    try {
      metadata = installer.metadata(name)
    } catch (error) {
      metadataFailure = messageOf(error)
    }
  }
  let packageManifest: ReturnType<PluginInstaller['readInstalledManifest']>
  try {
    packageManifest = installer.readInstalledManifest(name)
  } catch (error) {
    metadataFailure = messageOf(error)
  }
  const kind = metadata?.kind ?? (layer !== undefined || packageManifest?.dsh?.bundle !== undefined ? 'bundle' : 'unknown')
  const composed = layer !== undefined
  const rootTree = rootIncludeEntry(ctx.root)?.subtree
  const affected = allIssues.filter(issue => runtime.originOfEntry(issue.entry)?.packageName === name
    || (issue.entry.parent.tree === rootTree && metadata?.overrides.includes(issue.entry.options.id)))
  const rows = composed ? composedRows(ctx, runtime, name, allIssues) : declaredRows(metadata)
  const status = packageStatus({ kind, installed, enabled, composed, liveReload, metadataFailure, rows, affected })
  const reason = metadataFailure ?? (status === 'restart-required'
    ? 'the profile applies layer changes at its next start'
    : status === 'failed' && enabled !== composed
      ? 'the requested bundle state has not been applied to the live profile'
      : status === 'failed' || status === 'partial'
        ? affected[0]?.message ?? rows.find(row => row.failure !== undefined)?.failure?.message
        : undefined)
  return {
    name,
    ...optional('version', packageManifest?.version),
    ...optional('title', packageManifest?.dsh?.title),
    ...optional('description', packageManifest?.description),
    kind,
    installed,
    enabled,
    status,
    ...optional('reason', reason),
    ...optional('enginesDsh', metadata?.enginesDsh),
    cordisSameCopy: metadata?.cordisSameCopy ?? null,
    rows,
    overrides: metadata?.overrides ?? [],
    ...affected.length === 0 ? {} : { issues: affected.map(issue => ({
      entryId: issue.entry.id, moduleName: issue.entry.options.name, stage: issue.stage, message: issue.message,
    })) },
    liveReload,
  }
}

/** The package's status, folded from what the view already knows. */
function packageStatus(facts: {
  kind: PluginPackageView['kind']
  installed: boolean
  enabled: boolean
  composed: boolean
  liveReload: boolean
  metadataFailure: string | undefined
  affected: readonly EntryIssue[]
  rows: readonly PluginPackageRowView[]
}): PluginPackageStatus {
  if (facts.kind !== 'bundle') return 'plain'
  if (facts.installed && facts.metadataFailure !== undefined) return 'not-enableable'
  if (facts.enabled !== facts.composed) return facts.liveReload ? 'failed' : 'restart-required'
  if (!facts.enabled) return 'disabled'
  const live = facts.rows.filter(row => row.enabled)
  if (live.length === 0) return facts.affected.length === 0 ? 'running' : 'failed'
  const active = live.filter(row => row.phase === 'active').length
  if (active === live.length && facts.affected.length === 0) return 'running'
  return active === 0 ? 'failed' : 'partial'
}

/** Current native entries and failed groups belonging to the bundle. */
function composedRows(ctx: Context, runtime: ProfileRuntime, name: string, issues: readonly EntryIssue[]): PluginPackageRowView[] {
  const failures = new Map(issues.map(issue => [issue.entry, issue]))
  const rows: PluginPackageRowView[] = []
  for (const entry of ctx.loader.entries()) {
    if (runtime.originOfEntry(entry)?.packageName !== name) continue
    const failure = failures.get(entry)
    if (entry.options.group && failure === undefined) continue
    const enabled = failure?.stage === 'disabled-expression' || !entry.disabled
    rows.push({
      entryId: entry.id,
      rowId: entry.options.id,
      moduleName: entry.options.name,
      enabled,
      ...enabled ? {} : { disabledBy: runtime.userDisables(entry) ? 'user' as const : 'composition' as const },
      phase: entry.fiber === undefined ? (failure === undefined ? null : 'failed') : ROW_PHASE[entry.fiber.state],
      ...failure === undefined ? {} : { failure: { stage: failure.stage, message: failure.message } },
    })
  }
  // A row the composition left out never reached the tree; the runtime's
  // conflicts name the bundle that lost, so nothing is looked up by id.
  for (const conflict of runtime.conflicts) {
    if (conflict.packageName !== name) continue
    rows.push({
      entryId: `conflict:${conflict.layer}:${conflict.rowId}`,
      rowId: conflict.rowId,
      moduleName: conflict.moduleName,
      enabled: true,
      phase: 'failed',
      failure: { stage: 'conflict', message: conflict.message },
    })
  }
  return rows
}

/**
 * The non-group tree entries a package's layer inserted.
 * @param ctx - the context whose Loader tree to walk.
 * @param runtime - the booted profile, which says which layer owns each row id.
 * @param name - the package.
 * @returns the entries with the row ids their patches declare.
 */
export function ownedEntries(ctx: Context, runtime: ProfileRuntime, name: string): RowFacts[] {
  const found: RowFacts[] = []
  for (const entry of ctx.loader.entries()) {
    if (entry.options.group) continue
    const rowId = entry.options.id
    if (runtime.originOfEntry(entry)?.packageName !== name) continue
    found.push({ entry, rowId })
  }
  return found
}

/** The rows a bundle would contribute, from its patch declarations, when it is not composed. */
function declaredRows(metadata: PackageMetadata | undefined): PluginPackageRowView[] {
  return (metadata?.rows ?? []).map(row => ({
    entryId: row.id ?? row.name,
    rowId: row.id ?? row.name,
    moduleName: row.name,
    enabled: !row.gated,
    ...row.gated ? { disabledBy: 'composition' as const } : {},
    phase: null,
  }))
}
