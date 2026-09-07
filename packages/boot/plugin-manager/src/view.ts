/**
 * The view fold: one package's manifest facts, probe record, and live-tree
 * rows folded into the `PluginPackageView` the manager lists, plus the row
 * ownership walk the dependents query shares.
 * @module @deepseek-ai/dsh-plugin-manager/view
 */

import type { Context, FiberState } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import { layerTrust, type PluginProbe, type ProfileManifest, type ProfileRuntime } from '@deepseek-ai/dsh-app-boot'
import type { BundleStage } from '@deepseek-ai/dsh-package-manifest'
import { bundlesOf, dependenciesOf, messageOf, optional } from './helpers.ts'
import type { PluginInstaller } from './installer.ts'
import { addableViews } from './modules.ts'
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

/** Fields of one row's provenance a package view needs. */
export interface RowFacts {
  readonly entry: Entry
  readonly rowId: string
}

/**
 * Fold one package's manifest, probe, and tree facts into its view.
 * @param ctx - the context whose Loader tree and failure registry the rows come from.
 * @param runtime - the booted profile.
 * @param installer - the installer over the same profile, for the probe record and the installed manifest.
 * @param manifest - the profile manifest, read once per list.
 * @param name - the package.
 * @returns the view.
 */
export async function packageView(
  ctx: Context,
  runtime: ProfileRuntime,
  installer: PluginInstaller,
  manifest: ProfileManifest,
  name: string,
): Promise<PluginPackageView> {
  const installed = name in dependenciesOf(manifest)
  const enabled = bundlesOf(manifest).includes(name)
  const layer = runtime.layers.find(candidate => candidate.packageName === name)
  const trust = layer?.trust ?? layerTrust(manifest, name)
  const liveReload = runtime.patchReload === 'live'
  let probe: PluginProbe | undefined
  let probeFailure: string | undefined
  if (installed) {
    try {
      probe = await installer.probe(name)
    } catch (error) {
      probeFailure = messageOf(error)
    }
  }
  const packageManifest = installer.readInstalledManifest(name)
  const stage: BundleStage = layer?.stage
    ?? (manifest.dsh?.profile?.stages?.[name] ?? packageManifest?.dsh?.bundle?.stage ?? 'runtime')
  const kind = probe?.kind ?? (layer !== undefined || packageManifest?.dsh?.bundle !== undefined ? 'bundle' : 'library')
  const composed = layer !== undefined
  const rows = composed ? composedRows(ctx, runtime, name) : probedRows(probe)
  const status = packageStatus({ kind, installed, enabled, composed, liveReload, probe, probeFailure, rows })
  const reason = probeFailure ?? probe?.reason ?? (status === 'restart-required'
    ? 'the profile applies layer changes at its next start'
    : status === 'failed' || status === 'partial'
      ? rows.find(row => row.failure !== undefined)?.failure?.message
      : undefined)
  return {
    name,
    ...optional('version', packageManifest?.version),
    ...optional('title', packageManifest?.dsh?.title),
    ...optional('description', packageManifest?.description),
    kind,
    trust,
    stage,
    installed,
    enabled,
    status,
    ...optional('reason', reason),
    ...optional('enginesDsh', probe?.enginesDsh),
    cordisSameCopy: probe?.cordisSameCopy ?? null,
    rows,
    overrides: probe?.overrides ?? [],
    addable: addableViews(name, probe),
    ...optional('probedAt', probe?.checkedAt),
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
  probe: PluginProbe | undefined
  probeFailure: string | undefined
  rows: readonly PluginPackageRowView[]
}): PluginPackageStatus {
  if (facts.kind !== 'bundle') return 'plain'
  if (facts.installed && (facts.probeFailure !== undefined || facts.probe?.ok === false)) return 'not-enableable'
  if (facts.enabled !== facts.composed) return 'restart-required'
  if (!facts.enabled) return 'disabled'
  const live = facts.rows.filter(row => row.enabled)
  if (live.length === 0) return 'running'
  const active = live.filter(row => row.phase === 'active').length
  if (active === live.length) return 'running'
  return active === 0 ? 'failed' : 'partial'
}

/** The rows a composed bundle owns in the live tree, plus rows only the failure registry knows. */
function composedRows(ctx: Context, runtime: ProfileRuntime, name: string): PluginPackageRowView[] {
  const failures = ctx.get('pluginFailures')
  const userDisabled = runtime.userDisabledRowIds()
  const rows: PluginPackageRowView[] = []
  const listed = new Set<string>()
  for (const { entry, rowId } of ownedEntries(ctx, runtime, name)) {
    listed.add(entry.id)
    const failure = failures?.get(entry.id)
    rows.push({
      entryId: entry.id,
      rowId,
      moduleName: entry.options.name,
      enabled: !entry.disabled,
      ...entry.disabled ? { disabledBy: userDisabled.has(rowId) ? 'user' as const : 'composition' as const } : {},
      phase: entry.fiber === undefined ? null : ROW_PHASE[entry.fiber.state],
      ...failure === undefined ? {} : { failure: { stage: failure.stage, message: failure.message } },
    })
  }
  /* v8 ignore next -- the root include provides the registry on every boot; the guard answers its optional type */
  for (const failure of failures?.list() ?? []) {
    if (listed.has(failure.entryId)) continue
    if (runtime.originOf(failure.rowId)?.packageName !== name) continue
    rows.push({
      entryId: failure.entryId,
      rowId: failure.rowId,
      moduleName: failure.moduleName,
      enabled: true,
      phase: 'failed',
      failure: { stage: failure.stage, message: failure.message },
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
    if (runtime.originOf(rowId)?.packageName !== name) continue
    found.push({ entry, rowId })
  }
  return found
}

/** The rows a bundle would contribute, from its probe record, when it is not composed. */
function probedRows(probe: PluginProbe | undefined): PluginPackageRowView[] {
  return (probe?.rows ?? []).map(row => ({
    entryId: row.id ?? row.name,
    rowId: row.id ?? row.name,
    moduleName: row.name,
    enabled: !row.gated,
    ...row.gated ? { disabledBy: 'composition' as const } : {},
    phase: null,
  }))
}
