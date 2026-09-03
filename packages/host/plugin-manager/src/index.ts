/**
 * Plugin management over the booted profile.
 *
 * The profile launcher composes the host tree from bundle layers and user
 * patch files and, since `profileRuntime`, can recompose it while running.
 * This service is the one place that changes what those layers are: it runs
 * pnpm in the profile directory to install or remove a package, moves a
 * bundle in and out of the profile's layer list, recomposes the tree through
 * the runtime and reports the outcome, retries a bundle whose rows failed,
 * adds and removes rows in the profile's global user layer or one agent
 * preset's, and folds the manifest, the probe record, and the live tree into
 * one view per package for the `plugins` Remote. Every change is followed by
 * `plugins/changed`; an install run streams pnpm's output as
 * `plugins/install-log`.
 * @module @deepseek-ai/dsh-host-plugin-manager
 */

import { spawn as spawnChild, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Context, Fiber, FiberState } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import type { AgentPresets } from '@deepseek-ai/dsh-agent-presets'
import {
  bundleGroupId,
  disableBundle,
  enableBundle,
  externalRowId,
  healProfilesModuleFallback,
  layerTrust,
  loadProfile,
  PLUGIN_PROBE_DIR,
  probePackage,
  readProbeCache,
  readProfileManifest,
  reconcileInstalledBundles,
  recordContainedStates,
  resolveBundleDir,
  writeProbeCache,
  type BundleStage,
  type PluginProbe,
  type ProfileManifest,
  type ProfileRuntime,
} from '@deepseek-ai/dsh-app-boot'
import { mutatePatchFile, readPatchListFile, type PatchRow } from '@deepseek-ai/dsh-patch-file'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import type {
  PluginChangeReason,
  PluginDependents,
  PluginEnableResult,
  PluginInstallResult,
  PluginPackageAddableView,
  PluginPackageRowView,
  PluginPackageStatus,
  PluginPackageView,
  PluginRowAddition,
  PluginRowPhase,
  PluginRowReference,
  PluginRowTarget,
  PluginServiceDependent,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Plugin management over the booted profile; mounted by the web bundle. */
    pluginManager: PluginManager
  }
}

/** Diagnostic prefix on errors this service raises through app-boot helpers. */
const NAME = 'plugin-manager'

/** The message of a thrown value; a non-Error keeps its text. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The profile's installed dependencies by name; a hand-written manifest may omit the field. */
function dependenciesOf(manifest: ProfileManifest): Record<string, string> {
  return manifest.dependencies ?? {}
}

/** The profile's enabled layer list; a hand-written manifest may omit the section. */
function bundlesOf(manifest: ProfileManifest): readonly string[] {
  return manifest.dsh?.profile?.bundles ?? []
}

/** Plugin config: the pnpm command and the bounds on the child processes this service runs. */
export interface Config {
  /** The pnpm executable name or path; resolved through `PATH` like the `dsh plugin` command. */
  pnpmCommand: string
  /** Bound on one install or remove run, in milliseconds. */
  installTimeoutMs: number
  /** Bound on one package probe, in milliseconds. */
  probeTimeoutMs: number
  /** How many trailing bytes of an install run's output an install failure reports. */
  installLogTailBytes: number
}

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

/** The spawn function, replaceable in tests so no pnpm runs. */
export type SpawnLike = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

/** Test seams: the child spawner and the package probe. */
export interface PluginManagerInternals {
  spawn?: SpawnLike
  probe?: typeof probePackage
}

/** The installed package's manifest slice the view reads. */
type InstalledManifest = ProfileManifest & { description?: string; dsh?: ProfileManifest['dsh'] & { title?: string } }

/** Fields of one row's provenance a package view needs. */
interface RowFacts {
  readonly entry: Entry
  readonly rowId: string
}

/**
 * The `pluginManager` service and the `plugins` Remote.
 *
 * Every method that changes the profile reads the manifest afresh and writes
 * it through the app-boot helpers the `dsh plugin` command uses, so the CLI
 * and the manager never disagree on the file. The profile runtime is
 * resolved per call: a composition without it (a test, a launcher other than
 * the profile launcher) still mounts this service, and every call then
 * reports `plugins/unavailable` rather than the service failing to start.
 */
export class PluginManager extends TypertRemoteService {
  static inject = ['loader']

  static Config: z<Config> = z.object({
    pnpmCommand: z.string().default('pnpm'),
    installTimeoutMs: z.number().min(1_000).default(600_000),
    probeTimeoutMs: z.number().min(1_000).default(20_000),
    installLogTailBytes: z.number().min(256).default(16_384),
  })

  private readonly spawn: SpawnLike
  private readonly probeRunner: typeof probePackage

  constructor(ctx: Context, public config: Config, internals: PluginManagerInternals = {}) {
    super(ctx, 'pluginManager', { namespace: 'plugins' })
    this.spawn = internals.spawn ?? spawnChild
    this.probeRunner = internals.probe ?? probePackage
  }

  /** The profile runtime, or the failure a caller without one receives. */
  private runtime(): ProfileRuntime {
    const runtime = this.ctx.get('profileRuntime')
    if (runtime === undefined) {
      throw new RemoteError(
        'plugins/unavailable',
        'plugin-manager: no profile is composed in this process, so there are no plugins to manage',
        { reason: 'no profile runtime' },
      )
    }
    return runtime
  }

  /**
   * Every package the profile knows: its template and installed bundles,
   * and every other installed dependency.
   * @returns one view per package, bundles first in layer order.
   */
  @Remote('list')
  async list(): Promise<PluginPackageView[]> {
    const runtime = this.runtime()
    const manifest = readProfileManifest(NAME, runtime.dir)
    const names = [...new Set([...bundlesOf(manifest), ...Object.keys(dependenciesOf(manifest))])]
    const views: PluginPackageView[] = []
    for (const name of names) views.push(await this.view(runtime, manifest, name))
    return views
  }

  /** Fold one package's manifest, probe, and tree facts into its view. */
  private async view(runtime: ProfileRuntime, manifest: ProfileManifest, name: string): Promise<PluginPackageView> {
    const installed = name in dependenciesOf(manifest)
    const enabled = bundlesOf(manifest).includes(name)
    const layer = runtime.layers.find(candidate => candidate.packageName === name)
    const trust = layer?.trust ?? layerTrust(manifest, name)
    const liveReload = runtime.patchReload === 'live'
    let probe: PluginProbe | undefined
    let probeFailure: string | undefined
    if (installed) {
      try {
        probe = await this.probe(runtime, name)
      } catch (error) {
        probeFailure = messageOf(error)
      }
    }
    const packageManifest = readInstalledManifest(runtime, name)
    const stage: BundleStage = layer?.stage
      ?? (manifest.dsh?.profile?.stages?.[name] ?? packageManifest?.dsh?.bundle?.stage ?? 'runtime')
    const kind = probe?.kind ?? (layer !== undefined || packageManifest?.dsh?.bundle !== undefined ? 'bundle' : 'library')
    const composed = layer !== undefined
    const rows = composed ? this.composedRows(runtime, name) : this.probedRows(name, trust, probe)
    const status = this.status({ kind, installed, enabled, composed, liveReload, probe, probeFailure, rows })
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
  private status(facts: {
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
  private composedRows(runtime: ProfileRuntime, name: string): PluginPackageRowView[] {
    const failures = this.ctx.get('pluginFailures')
    const userDisabled = runtime.userDisabledRowIds()
    const rows: PluginPackageRowView[] = []
    const listed = new Set<string>()
    for (const { entry, rowId } of this.ownedEntries(runtime, name)) {
      listed.add(entry.id)
      const origin = runtime.originOf(rowId)
      const failure = failures?.get(entry.id)
      rows.push({
        entryId: entry.id,
        ...optional('originalId', origin?.originalId),
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
      const origin = runtime.originOf(failure.rowId)
      if (origin?.packageName !== name) continue
      rows.push({
        entryId: failure.entryId,
        ...optional('originalId', origin.originalId),
        moduleName: failure.moduleName,
        enabled: true,
        phase: 'failed',
        failure: { stage: failure.stage, message: failure.message },
      })
    }
    return rows
  }

  /** The non-group tree entries a package's layer inserted. */
  private ownedEntries(runtime: ProfileRuntime, name: string): RowFacts[] {
    const found: RowFacts[] = []
    for (const entry of this.ctx.loader.entries()) {
      if (entry.options.group) continue
      const rowId = entry.options.id
      if (runtime.originOf(rowId)?.packageName !== name) continue
      found.push({ entry, rowId })
    }
    return found
  }

  /** The rows a bundle would contribute, from its probe record, when it is not composed. */
  private probedRows(name: string, trust: PluginPackageView['trust'], probe: PluginProbe | undefined): PluginPackageRowView[] {
    return (probe?.rows ?? []).map(row => ({
      entryId: row.id === undefined ? row.name : trust === 'external' ? externalRowId(name, row.id) : row.id,
      ...optional('originalId', row.id),
      moduleName: row.name,
      enabled: !row.gated,
      ...row.gated ? { disabledBy: 'composition' as const } : {},
      phase: null,
    }))
  }

  /** The package's probe record, from the profile cache or a fresh probe written to it. */
  private async probe(runtime: ProfileRuntime, name: string): Promise<PluginProbe> {
    const version = readInstalledManifest(runtime, name)?.version
    const cached = readProbeCache(runtime.dir, name, version)
    if (cached !== undefined) return cached
    const probe = await this.probeRunner({
      binName: NAME,
      profileDir: runtime.dir,
      installAnchor: runtime.installAnchor,
      packageName: name,
      timeoutMs: this.config.probeTimeoutMs,
    })
    writeProbeCache(runtime.dir, probe)
    return probe
  }

  /**
   * Install a package into the profile with pnpm, probe it, and leave it
   * disabled unless asked otherwise. The run's output streams as
   * `plugins/install-log` chunks carrying the returned `jobId`.
   * @param spec - what to install, in pnpm's own vocabulary: a registry
   * name, a `github:` or git URL, a tarball, or an absolute path.
   * @param options - `enable` puts every newly installed bundle into the layer list at once.
   * @returns what the run installed and enabled.
   * @throws {RemoteError} `plugins/install-failed` when pnpm exits non-zero
   * or the run times out, `plugins/enable-failed` when enabling was asked
   * for and the tree rejected the bundle.
   */
  @Remote('add')
  async add(spec: string, options?: { enable?: boolean }): Promise<PluginInstallResult> {
    const runtime = this.runtime()
    if (spec.trim().length === 0) {
      throw new RemoteError('gateway/bad-request', 'plugin-manager: the package spec must not be empty', {})
    }
    const before = readProfileManifest(NAME, runtime.dir)
    const jobId = await this.runPnpm(runtime, ['add', spec], spec)
    const outcome = reconcileInstalledBundles(NAME, runtime.dir, runtime.installAnchor, before, { autoEnable: false })
    const after = readProfileManifest(NAME, runtime.dir)
    const installed = Object.keys(dependenciesOf(after)).filter(name => !(name in dependenciesOf(before)))
    await healProfilesModuleFallback({ installAnchor: runtime.installAnchor, profile: runtime.current })
    for (const name of installed) {
      // A probe that cannot run leaves no record; the view reports the
      // package as not enableable with the probe's own reason.
      try {
        await this.probe(runtime, name)
      } catch {
        // The failure is re-derived on every list and shown there.
      }
    }
    const enabled: string[] = []
    if (options?.enable === true) {
      for (const name of outcome.installedOnly) {
        await this.enable(name)
        enabled.push(name)
      }
    }
    this.changed('install')
    return {
      installed,
      enabled,
      installedOnly: outcome.installedOnly.filter(name => !enabled.includes(name)),
      plain: outcome.plain,
      jobId,
    }
  }

  /**
   * Remove a package from the profile: disable it when enabled, drop every
   * user-layer row that names it, run `pnpm remove`, and forget its probe.
   * @param packageName - the installed dependency to remove.
   * @throws {RemoteError} `plugins/not-installed`, or `plugins/install-failed` when pnpm exits non-zero.
   */
  @Remote('uninstall')
  async uninstall(packageName: string): Promise<void> {
    const runtime = this.runtime()
    this.assertInstalled(runtime, packageName)
    const references = await this.rowReferences(runtime, packageName)
    if (bundlesOf(readProfileManifest(NAME, runtime.dir)).includes(packageName)) {
      await this.disable(packageName)
    }
    for (const reference of references) {
      await this.editLayer(runtime, reference.target, (document) => { document.removeInsert(reference.rowId) })
    }
    const before = readProfileManifest(NAME, runtime.dir)
    await this.runPnpm(runtime, ['remove', packageName], packageName)
    reconcileInstalledBundles(NAME, runtime.dir, runtime.installAnchor, before, { autoEnable: false })
    rmSync(join(runtime.dir, PLUGIN_PROBE_DIR, `${packageName.replaceAll('/', '__')}.json`), { force: true })
    if (references.some(reference => reference.target.kind === 'global') && runtime.patchReload === 'live') {
      await runtime.recompose()
    }
    this.changed('uninstall', packageName)
  }

  /**
   * Put an installed bundle into the layer list and, on a live profile,
   * recompose the tree with it. A rejected recomposition restores the list
   * and reports the tree's reason; the tree that was running keeps running.
   * @param packageName - the installed bundle.
   * @returns whether the list changed and whether the change is live.
   * @throws {RemoteError} `plugins/not-installed`, `plugins/not-enableable`
   * for a package that declares no bundle or whose probe refused it, or
   * `plugins/enable-failed`.
   */
  @Remote('enable')
  async enable(packageName: string): Promise<PluginEnableResult> {
    const runtime = this.runtime()
    this.assertInstalled(runtime, packageName)
    const probe = await this.probe(runtime, packageName).catch((error: unknown) => {
      const reason = `cannot be probed: ${messageOf(error)}`
      throw new RemoteError('plugins/not-enableable', `plugin-manager: ${packageName} ${reason}`, { packageName, reason })
    })
    if (!probe.ok) {
      // The probe states a reason with every refusal; the fallback keeps the type total.
      /* v8 ignore next */
      const reason = probe.reason ?? 'the probe refused it'
      throw new RemoteError('plugins/not-enableable', `plugin-manager: ${packageName} cannot be enabled: ${reason}`, { packageName, reason })
    }
    let changed: boolean
    try {
      changed = enableBundle(NAME, runtime.dir, runtime.installAnchor, packageName)
    } catch (error) {
      const reason = messageOf(error)
      throw new RemoteError('plugins/not-enableable', reason, { packageName, reason })
    }
    if (runtime.patchReload !== 'live') {
      this.changed('enable', packageName)
      return { changed, effect: 'restart' }
    }
    if (changed) {
      try {
        // Links for the packages the bundle carries must exist before the
        // recomposition imports its rows.
        await healProfilesModuleFallback({
          installAnchor: runtime.installAnchor,
          profile: loadProfile(NAME, runtime.profileName, runtime.installAnchor, undefined, { userLayer: false }),
        })
        await runtime.recompose({ reloadBundles: true })
        // The boot audit does not run again; record what the bundle's rows
        // came to, so the list shows a waiting or failed row with its reason.
        await recordContainedStates(this.ctx)
      } catch (error) {
        const reason = messageOf(error)
        disableBundle(NAME, runtime.dir, packageName)
        // The tree without the bundle is the tree that was running a moment
        // ago; recomposing back to it is the update that already succeeded.
        /* v8 ignore next */
        await runtime.recompose({ reloadBundles: true }).catch(() => undefined)
        throw new RemoteError(
          'plugins/enable-failed',
          `plugin-manager: enabling ${packageName} failed and the layer list was restored: ${reason}`,
          { packageName, reason },
          { cause: error },
        )
      }
    }
    this.changed('enable', packageName)
    return { changed, effect: 'live' }
  }

  /**
   * Take a bundle out of the layer list and, on a live profile, recompose
   * the tree without it.
   * @param packageName - the enabled bundle.
   * @returns whether the list changed and whether the change is live.
   * @throws {RemoteError} `gateway/bad-request` for a template bundle, which is not a dependency.
   */
  @Remote('disable')
  async disable(packageName: string): Promise<PluginEnableResult> {
    const runtime = this.runtime()
    let changed: boolean
    try {
      changed = disableBundle(NAME, runtime.dir, packageName)
    } catch (error) {
      throw new RemoteError('gateway/bad-request', messageOf(error), {})
    }
    if (runtime.patchReload !== 'live') {
      this.changed('disable', packageName)
      return { changed, effect: 'restart' }
    }
    if (changed) await runtime.recompose({ reloadBundles: true })
    this.changed('disable', packageName)
    return { changed, effect: 'live' }
  }

  /**
   * Compose an enabled bundle again from scratch: its group leaves the tree
   * and returns, so rows that failed at boot get another start.
   * @param packageName - the enabled bundle.
   * @returns the enable outcome of the second step.
   * @throws {RemoteError} `gateway/bad-request` when the bundle is not enabled, or the enable failures.
   */
  @Remote('retry')
  async retry(packageName: string): Promise<PluginEnableResult> {
    const runtime = this.runtime()
    if (!bundlesOf(readProfileManifest(NAME, runtime.dir)).includes(packageName)) {
      throw new RemoteError('gateway/bad-request', `plugin-manager: ${packageName} is not enabled`, {})
    }
    await this.disable(packageName)
    const result = await this.enable(packageName)
    this.changed('retry', packageName)
    return result
  }

  /**
   * Add a row naming one of the package's modules to a user layer: the
   * profile's global `cordis.patch.yml`, or an agent preset's.
   * @param packageName - the installed package.
   * @param target - which layer.
   * @param options - `module` selects a declared `dsh.plugins[]` name (default `.`),
   * `id` overrides the derived row id, `config` overrides the declared default.
   * @returns where the row landed.
   * @throws {RemoteError} `plugins/not-installed`, `plugins/not-enableable`
   * when the module is not one the probe found addable, `plugins/row-conflict`,
   * or `plugins/unavailable` for a preset target without a roster.
   */
  @Remote('addRow')
  async addRow(
    packageName: string,
    target: PluginRowTarget,
    options?: { module?: string; id?: string; config?: JsonValue },
  ): Promise<PluginRowAddition> {
    const runtime = this.runtime()
    this.assertInstalled(runtime, packageName)
    const probe = await this.probe(runtime, packageName)
    const declared = options?.module ?? '.'
    const addable = declared === '.' && probe.kind === 'plugin'
      ? { ok: true, config: undefined, error: undefined }
      : probe.addable.find(entry => entry.name === declared)
    if (addable === undefined || !addable.ok) {
      const reason = addable?.error ?? `${declared} is not a module ${packageName} declares addable`
      throw new RemoteError('plugins/not-enableable', `plugin-manager: ${reason}`, { packageName, reason })
    }
    const moduleName = moduleSpecifier(packageName, declared)
    const rowId = options?.id ?? derivedRowId(packageName, declared)
    const row: PatchRow = { id: rowId, name: moduleName, config: options?.config ?? addable.config ?? {} }
    if (await this.rowExists(runtime, target, rowId)) {
      throw new RemoteError('plugins/row-conflict', `plugin-manager: a row ${JSON.stringify(rowId)} already exists`, { rowId, target })
    }
    const file = await this.editLayer(runtime, target, (document) => { document.appendInsert(row) })
    this.changed('row', packageName)
    return { target, rowId, file }
  }

  /**
   * Remove a row a user layer inserted.
   * @param target - which layer.
   * @param rowId - the inserted row's id.
   * @throws {RemoteError} `gateway/bad-request` when the layer inserts no such row.
   */
  @Remote('removeRow')
  async removeRow(target: PluginRowTarget, rowId: string): Promise<void> {
    const runtime = this.runtime()
    // A holder rather than a `let`: the assignment happens inside the edit
    // callback, which control-flow narrowing does not see.
    const outcome = { removed: false }
    await this.editLayer(runtime, target, (document) => { outcome.removed = document.removeInsert(rowId) })
    if (!outcome.removed) {
      throw new RemoteError('gateway/bad-request', `plugin-manager: the layer inserts no row ${JSON.stringify(rowId)}`, {})
    }
    this.changed('row')
  }

  /**
   * Switch one row off or on in a user layer. Deny-only: `true` writes
   * `disabled: true` for the row, `false` removes that key, so a bundle's
   * own `!!js` gate is restored rather than overridden.
   * @param target - which layer.
   * @param rowId - the row's id as the composition declares it.
   * @param disabled - whether the layer should switch the row off.
   */
  @Remote('setRowDisabled')
  async setRowDisabled(target: PluginRowTarget, rowId: string, disabled: boolean): Promise<void> {
    const runtime = this.runtime()
    await this.editLayer(runtime, target, (document) => {
      if (disabled) document.setRowField(rowId, 'disabled', true)
      else document.deleteRowField(rowId, 'disabled')
    })
    this.changed('row')
  }

  /**
   * What disabling or removing a package would strand: services its rows
   * provide that rows outside it inject, and user-layer rows naming its modules.
   * @param packageName - the package.
   * @returns the dependents.
   */
  @Remote('dependents')
  async dependents(packageName: string): Promise<PluginDependents> {
    const runtime = this.runtime()
    const owned = this.ownedEntries(runtime, packageName)
    const ownedIds = new Set(owned.map(({ entry }) => entry.id))
    const store = this.ctx.reflect.store
    const services: PluginServiceDependent[] = []
    for (const { entry } of owned) {
      const fiber = entry.fiber
      if (fiber === undefined) continue
      for (const key of Object.getOwnPropertySymbols(store)) {
        const impl = store[key]
        /* v8 ignore next -- cordis deletes a store slot on disposal rather than clearing it */
        if (impl === undefined || !withinFiber(impl.fiber, fiber)) continue
        const injectedBy: string[] = []
        for (const other of this.ctx.loader.entries()) {
          if (ownedIds.has(other.id) || other.fiber === undefined) continue
          if (impl.name in other.fiber.inject) injectedBy.push(other.id)
        }
        if (injectedBy.length > 0) services.push({ service: impl.name, providedBy: entry.id, injectedBy })
      }
    }
    return { services, references: await this.rowReferences(runtime, packageName) }
  }

  /** Every user-layer row naming the package or one of its subpaths. */
  private async rowReferences(runtime: ProfileRuntime, packageName: string): Promise<PluginRowReference[]> {
    const found: PluginRowReference[] = []
    const names = (target: PluginRowTarget, rows: readonly PatchRow[]): void => {
      for (const row of rows) {
        // A group's config is a row list once the patch parser accepted the file.
        /* v8 ignore next */
        if (row.group === true) names(target, (row.config ?? []) as PatchRow[])
        if (typeof row.id !== 'string') continue
        if (row.name === packageName || row.name.startsWith(`${packageName}/`)) {
          found.push({ target, rowId: row.id, moduleName: row.name })
        }
      }
    }
    const scan = async (target: PluginRowTarget, file: string): Promise<void> => {
      let patches
      try {
        patches = await readPatchListFile(NAME, file, 'patches')
      } catch {
        // An unreadable layer names nothing this call can act on; the
        // launcher and the roster report it as their own failure.
        return
      }
      for (const patch of patches ?? []) if (patch.insert !== undefined) names(target, patch.insert)
    }
    await scan({ kind: 'global' }, runtime.patchPath)
    const presets = this.ctx.get('agentPresets')
    if (presets !== undefined) {
      for (const preset of await presets.list()) {
        if (preset.overlayPath !== undefined) await scan({ kind: 'preset', preset: preset.id }, preset.overlayPath)
      }
    }
    return found
  }

  /** Whether the target layer's composition already carries a row with `rowId`. */
  private async rowExists(runtime: ProfileRuntime, target: PluginRowTarget, rowId: string): Promise<boolean> {
    if (target.kind === 'global') {
      return [...this.ctx.loader.entries()].some(entry => entry.options.id === rowId)
        || (await readPatchListFile(NAME, runtime.patchPath, 'patches') ?? []).some(patch => patch.insert?.some(row => row.id === rowId))
    }
    const presets = this.presets()
    const composition = (await presets.compositionInventory()).find(candidate => candidate.id === target.preset)
    return composition?.rows.some(row => row.entryId === rowId) ?? false
  }

  /** The roster, or the failure a preset target without one receives. */
  private presets(): AgentPresets {
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) {
      throw new RemoteError('plugins/unavailable', 'plugin-manager: no agent-preset roster is composed', { reason: 'no roster' })
    }
    return presets
  }

  /** Edit one user layer file and, for the live global layer, recompose. */
  private async editLayer(
    runtime: ProfileRuntime,
    target: PluginRowTarget,
    mutate: Parameters<typeof mutatePatchFile>[1],
  ): Promise<string> {
    const file = target.kind === 'global' ? runtime.patchPath : await this.presets().overlayPathFor(target.preset)
    await mutatePatchFile(file, mutate, { binName: NAME, mode: 0o600, dirMode: 0o700 })
    // The profile launcher's watcher reapplies the global file on its own;
    // recomposing here makes the change visible to this call's caller before
    // it returns, and the watcher's later pass composes the same text.
    if (target.kind === 'global' && runtime.patchReload === 'live') await runtime.recompose()
    return file
  }

  private assertInstalled(runtime: ProfileRuntime, packageName: string): void {
    if (packageName in dependenciesOf(readProfileManifest(NAME, runtime.dir))) return
    throw new RemoteError(
      'plugins/not-installed',
      `plugin-manager: ${packageName} is not installed in profile ${runtime.profileName}`,
      { packageName },
    )
  }

  /**
   * Run one pnpm command in the profile directory, streaming its output as
   * `plugins/install-log` chunks.
   * @returns the run's job id.
   * @throws {RemoteError} `plugins/install-failed` on a non-zero exit, a signal, or the timeout.
   */
  private async runPnpm(runtime: ProfileRuntime, args: readonly string[], spec: string): Promise<string> {
    const jobId = randomUUID()
    const tail: string[] = []
    let tailBytes = 0
    const record = (stream: 'stdout' | 'stderr', text: string): void => {
      tail.push(text)
      tailBytes += Buffer.byteLength(text)
      while (tailBytes > this.config.installLogTailBytes && tail.length > 1) {
        tailBytes -= Buffer.byteLength(tail.shift() as string)
      }
      this.ctx.emit('plugins/install-log', { jobId, spec, stream, text })
    }
    // Windows resolves pnpm through its .cmd shim, which spawn() refuses
    // without a shell since the CVE-2024-27980 hardening. The parent
    // environment is passed whole, as the `dsh plugin` command does: pnpm
    // needs the user's registry, proxy, and auth settings.
    const child = this.spawn(this.config.pnpmCommand, args, {
      cwd: runtime.dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: process.env,
    })
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (text: string) => { record('stdout', text) })
    child.stderr?.on('data', (text: string) => { record('stderr', text) })
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      let settled = false
      const settle = (outcome: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        outcome()
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        settle(() => { reject(new Error(`${NAME}: pnpm ${args.join(' ')} timed out after ${String(this.config.installTimeoutMs)}ms`)) })
      }, this.config.installTimeoutMs)
      child.on('error', (error) => { settle(() => { reject(error) }) })
      child.on('close', (code) => { settle(() => { resolve(code) }) })
    }).catch((error: unknown) => {
      const message = messageOf(error)
      record('stderr', `${message}\n`)
      this.ctx.emit('plugins/install-log', { jobId, spec, stream: 'stderr', text: '', exitCode: null })
      throw new RemoteError('plugins/install-failed', `plugin-manager: ${message}`, { spec, exitCode: null, log: tail.join('') }, { cause: error })
    })
    this.ctx.emit('plugins/install-log', { jobId, spec, stream: 'stdout', text: '', exitCode })
    if (exitCode !== 0) {
      throw new RemoteError(
        'plugins/install-failed',
        `plugin-manager: pnpm ${args.join(' ')} exited with ${String(exitCode)} in ${runtime.dir}`,
        { spec, exitCode, log: tail.join('') },
      )
    }
    return jobId
  }

  private changed(reason: PluginChangeReason, packageName?: string): void {
    this.ctx.emit('plugins/changed', { reason, ...optional('packageName', packageName) })
  }
}

/**
 * Whether `fiber` is `root` itself or sits anywhere inside its subtree: a
 * service is provided by a fiber under the row's root fiber (a `ctx.inject`
 * continuation, an `isolate` realm). An entry holds the thenable wrapper
 * `ctx.plugin()` returns, which is never identical to the fiber in a parent
 * chain, so fibers of one runtime compare by `uid`.
 */
function withinFiber(fiber: Fiber, root: Fiber): boolean {
  let current = fiber
  for (;;) {
    if (current === root || (current.uid !== null && current.uid === root.uid)) return true
    const parent = current.parent.fiber
    if (parent === current) return false
    current = parent
  }
}

/** One optional field, present only when its value is. */
function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return value === undefined ? {} : { [key]: value } as { [P in K]?: V }
}

/** The installed package's manifest, or undefined when it cannot be resolved from the profile. */
function readInstalledManifest(runtime: ProfileRuntime, name: string): InstalledManifest | undefined {
  let dir: string
  try {
    dir = resolveBundleDir(NAME, name, runtime.installAnchor, runtime.dir)
  } catch {
    // A dependency pnpm removed underneath the manifest, or one that never
    // materialized; the view reports what the manifest still says.
    return undefined
  }
  // resolveBundleDir answers only a directory holding a package.json.
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as InstalledManifest
}

/** The row `name` for one declared addable module. */
function moduleSpecifier(packageName: string, declared: string): string {
  if (declared === '.') return packageName
  return `${packageName}/${declared.replace(/^\.\//, '')}`
}

/** The row id derived from a package name and module: the unscoped name, then the subpath. */
function derivedRowId(packageName: string, declared: string): string {
  const base = packageName.replace(/^@/, '')
  return declared === '.' ? base : `${base}/${declared.replace(/^\.\//, '')}`
}

/** The wire view of one probed addable module. */
/**
 * The modules a package offers a composition: what it declares in
 * `dsh.plugins`, and — for a plugin module — its main export as `.`, the
 * implicit entry {@link PluginManager.addRow} accepts without a declaration.
 */
function addableViews(packageName: string, probe: PluginProbe | undefined): PluginPackageAddableView[] {
  const declared = (probe?.addable ?? []).map(entry => addableView(packageName, entry))
  if (probe?.kind !== 'plugin' || declared.some(entry => entry.declaredName === '.')) return declared
  return [{
    moduleName: packageName,
    declaredName: '.',
    ...optional('title', probe.title),
    ok: probe.ok,
    ...optional('error', probe.reason),
    ...optional('configSchema', probe.configSchema as JsonValue | undefined),
  }, ...declared]
}

function addableView(packageName: string, entry: PluginProbe['addable'][number]): PluginPackageAddableView {
  return {
    moduleName: moduleSpecifier(packageName, entry.name),
    declaredName: entry.name,
    ...optional('title', entry.title),
    // The probe read both from JSON: a manifest field and a child's report.
    ...optional('config', entry.config as JsonValue | undefined),
    ok: entry.ok,
    ...optional('error', entry.error),
    ...optional('configSchema', entry.configSchema as JsonValue | undefined),
  }
}

/** Group id of an isolated bundle, for callers that address its rows in the tree. */
export { bundleGroupId }

export default PluginManager
