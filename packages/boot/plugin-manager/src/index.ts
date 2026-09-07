/**
 * Plugin management over a dsh profile, shared by the `dsh plugin` command
 * and the Web host's `plugins` Remote.
 *
 * {@link PluginInstaller} changes what a profile has installed: it runs pnpm
 * in the profile directory, probes every new package in a child process, and
 * removes what has no place in a profile. It needs the profile on disk, not
 * a booted tree, so the CLI uses it before any plugin starts.
 * {@link PluginManager} adds the operations that need the booted tree —
 * enabling, disabling, and retrying bundles through the profile runtime,
 * rows in user layers, dependents, and one folded view per package — and
 * runs every mutation one at a time. Neither knows the Remote protocol: a
 * refusal or failure is a {@link PluginOperationError} carrying a `plugins/*`
 * code, which the Web host's adapter turns into a RemoteError of the same
 * code.
 * @module @deepseek-ai/dsh-plugin-manager
 */

import { spawn as spawnChild, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context, Fiber, FiberState } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import {
  awaitChildClose,
  bundleGroupId,
  claimLayerIds,
  disableBundle,
  enableBundle,
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
  resolveProfileLayer,
  writeProbeCache,
  type PluginProbe,
  type Profile,
  type ProfileManifest,
  type ProfileRuntime,
} from '@deepseek-ai/dsh-app-boot'
import type { BundleStage } from '@deepseek-ai/dsh-package-manifest'
import { mutatePatchFile, readPatchListFile, type PatchRow } from '@deepseek-ai/dsh-app-boot/patch-file'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { PluginOperationError } from './errors.ts'
import type {
  PluginChangeReason,
  PluginDependents,
  PluginEnableResult,
  PluginInstallLogChunk,
  PluginInstallRejection,
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

export * from './errors.ts'
export type * from './types.ts'

/** Diagnostic prefix on errors this package raises and on the app-boot helpers it calls. */
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

/** The pnpm command and the bounds on the child processes plugin management runs. */
export interface PluginToolingConfig {
  /** The pnpm executable name or path; resolved through `PATH` like the `dsh plugin` command. */
  readonly pnpmCommand: string
  /** Bound on one install or remove run, in milliseconds. */
  readonly installTimeoutMs: number
  /** Bound on one package probe, in milliseconds. */
  readonly probeTimeoutMs: number
  /** How many trailing bytes of an install run's output an install failure reports. */
  readonly installLogTailBytes: number
}

/** What one install run changed before any newly installed bundle was enabled. */
export type PluginInstallOutcome = Omit<PluginInstallResult, 'enabled'>

/** What {@link PluginInstaller} needs: the profile on disk, the tooling bounds, and where pnpm's output goes. */
export interface PluginInstallerOptions {
  /** The profile directory pnpm runs in and whose manifest records installs. */
  readonly profileDir: string
  /** The profile name, for diagnostics. */
  readonly profileName: string
  /** Absolute path of the dsh app's package.json: the first resolution anchor for installed packages. */
  readonly installAnchor: string
  /** The profile's composed layers, read when a new bundle's row ids are checked against them. */
  readonly loadProfile: () => Profile
  readonly config: PluginToolingConfig
  /** Receives every chunk of a pnpm run's output, in order; the last chunk carries the exit code. */
  readonly installLog: (chunk: PluginInstallLogChunk) => void
  /** Test seam: the child spawner; defaults to `node:child_process`. */
  readonly spawn?: SpawnLike
  /** Test seam: the package probe; defaults to app-boot's. */
  readonly probe?: typeof probePackage
}

/**
 * The agent-preset roster as row operations see it: where each preset's user
 * patch layer lives and which row ids its composition already carries. The
 * roster service satisfies this structurally; a host passes it in so this
 * package never imports the roster.
 */
export interface PresetLayers {
  /**
   * The user patch layer file of one preset, created on the first write.
   * @param presetId - the preset id.
   * @returns the absolute path.
   */
  overlayPathFor(presetId: string): Promise<string>
  /**
   * Every preset with the path of its user patch layer when it has one.
   * @returns the presets.
   */
  list(): Promise<readonly { readonly id: string; readonly overlayPath?: string }[]>
  /**
   * Every preset's composition as rows, under the ids the composition declares; an anonymous row has none.
   * @returns one composition per preset.
   */
  compositionInventory(): Promise<readonly { readonly id: string; readonly rows: readonly { readonly entryId: string | null }[] }[]>
}

/** What {@link PluginManager} needs beyond the Cordis context it reads the tree through. */
export interface PluginManagerOptions {
  readonly config: PluginToolingConfig
  /** The booted profile, read per call; `undefined` means no profile is composed in this process. */
  readonly runtime: () => ProfileRuntime | undefined
  /** The preset roster's layers, read per call; `undefined` when no roster is composed. */
  readonly presets: () => PresetLayers | undefined
  /** How many agents are running; `add` and `uninstall` refuse while any is. */
  readonly runningAgents: () => number
  /** Test seam: the child spawner; defaults to `node:child_process`. */
  readonly spawn?: SpawnLike
  /** Test seam: the package probe; defaults to app-boot's. */
  readonly probe?: typeof probePackage
}

/** The installed package's manifest slice the view reads. */
type InstalledManifest = ProfileManifest & { description?: string; dsh?: ProfileManifest['dsh'] & { title?: string } }

/** Fields of one row's provenance a package view needs. */
interface RowFacts {
  readonly entry: Entry
  readonly rowId: string
}

/**
 * Installs and removes packages in one profile with pnpm, and probes them.
 *
 * Every run reads the profile manifest afresh and writes it through the
 * app-boot helpers the `dsh plugin` command uses, so the CLI and the Web
 * host never disagree on the file: `dependencies` records what is installed,
 * `dsh.profile.bundles` what is enabled. Nothing here touches a running
 * tree, which is what lets the CLI install before any plugin starts.
 */
export class PluginInstaller {
  private readonly spawn: SpawnLike
  private readonly probeRunner: typeof probePackage

  /**
   * @param options - the profile, the tooling bounds, and the output sink.
   */
  constructor(private readonly options: PluginInstallerOptions) {
    this.spawn = options.spawn ?? spawnChild
    this.probeRunner = options.probe ?? probePackage
  }

  /**
   * Whether the package is a profile dependency.
   * @param packageName - the package.
   * @returns true when the manifest lists it.
   */
  isInstalled(packageName: string): boolean {
    return packageName in dependenciesOf(readProfileManifest(NAME, this.options.profileDir))
  }

  /**
   * Refuse a package the profile does not have.
   * @param packageName - the package.
   * @throws {PluginOperationError} `plugins/not-installed`.
   */
  assertInstalled(packageName: string): void {
    if (this.isInstalled(packageName)) return
    throw new PluginOperationError(
      'plugins/not-installed',
      `${NAME}: ${packageName} is not installed in profile ${this.options.profileName}`,
      { packageName },
    )
  }

  /**
   * The installed package's manifest.
   * @param packageName - the package.
   * @returns the manifest, or undefined when the package cannot be resolved from the profile.
   */
  readInstalledManifest(packageName: string): InstalledManifest | undefined {
    let dir: string
    try {
      dir = resolveBundleDir(NAME, packageName, this.options.installAnchor, this.options.profileDir)
    } catch {
      // A dependency pnpm removed underneath the manifest, or one that never
      // materialized; the caller reports what the manifest still says.
      return undefined
    }
    // resolveBundleDir answers only a directory holding a package.json.
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as InstalledManifest
  }

  /**
   * The package's probe record, from the profile cache or a fresh probe
   * written to it. A record for another installed version is not reused.
   * @param packageName - the installed package.
   * @returns the record.
   */
  async probe(packageName: string): Promise<PluginProbe> {
    const version = this.readInstalledManifest(packageName)?.version
    const cached = readProbeCache(this.options.profileDir, packageName, version)
    if (cached !== undefined) return cached
    const probe = await this.probeRunner({
      binName: NAME,
      profileDir: this.options.profileDir,
      installAnchor: this.options.installAnchor,
      packageName,
      timeoutMs: this.options.config.probeTimeoutMs,
    })
    writeProbeCache(this.options.profileDir, probe)
    return probe
  }

  /**
   * Install a package with pnpm, probe every package the run added, and
   * remove what has no place in a profile. New bundles are left disabled.
   * @param spec - what to install, in pnpm's own vocabulary: a registry
   * name, a `github:` or git URL, a tarball, or an absolute path.
   * @returns what the run installed and what it removed again.
   * @throws {PluginOperationError} `plugins/bad-request` for an empty spec,
   * `plugins/install-failed` when pnpm exits non-zero, cannot be spawned, or times out.
   */
  async add(spec: string): Promise<PluginInstallOutcome> {
    if (spec.trim().length === 0) {
      throw new PluginOperationError('plugins/bad-request', `${NAME}: the package spec must not be empty`, {})
    }
    const { profileDir, installAnchor } = this.options
    const manifestPath = join(profileDir, 'package.json')
    const snapshot = readFileSync(manifestPath, 'utf8')
    const before = readProfileManifest(NAME, profileDir)
    let jobId: string
    try {
      jobId = await this.runPnpm(['add', spec], spec)
    } catch (error) {
      // pnpm may have written the manifest before failing; the profile keeps
      // the manifest it had, and what pnpm left under node_modules is not a
      // dependency until a manifest names it.
      if (readFileSync(manifestPath, 'utf8') !== snapshot) writeFileSync(manifestPath, snapshot)
      throw error
    }
    const outcome = reconcileInstalledBundles(NAME, profileDir, installAnchor, before, { autoEnable: false })
    const after = readProfileManifest(NAME, profileDir)
    const added = Object.keys(dependenciesOf(after)).filter(name => !(name in dependenciesOf(before)))
    await healProfilesModuleFallback({ installAnchor, profile: this.options.loadProfile() })
    const installed: string[] = []
    const removed: PluginInstallRejection[] = []
    for (const name of added) {
      const reason = await this.rejection(name)
      if (reason === undefined) {
        installed.push(name)
        continue
      }
      await this.remove(name)
      removed.push({ name, reason })
    }
    const kept = new Set(installed)
    return {
      installed,
      removed,
      installedOnly: outcome.installedOnly.filter(name => kept.has(name)),
      plain: outcome.plain.filter(name => kept.has(name)),
      jobId,
    }
  }

  /**
   * Run `pnpm remove`, reconcile the layer list, and forget the probe record.
   * @param packageName - the dependency to remove.
   * @throws {PluginOperationError} `plugins/install-failed` when pnpm fails.
   */
  async remove(packageName: string): Promise<void> {
    const { profileDir, installAnchor } = this.options
    const before = readProfileManifest(NAME, profileDir)
    await this.runPnpm(['remove', packageName], packageName)
    reconcileInstalledBundles(NAME, profileDir, installAnchor, before, { autoEnable: false })
    rmSync(join(profileDir, PLUGIN_PROBE_DIR, `${packageName.replaceAll('/', '__')}.json`), { force: true })
  }

  /**
   * The post-install check of one package pnpm added: a package that is
   * neither a bundle nor a plugin module has no place in a profile, and a
   * bundle whose row id another layer already owns could only mount as a
   * conflict record. A package the probe cannot run stays installed: the
   * view reports it as not enableable with the probe's own reason.
   * @returns why the package is removed again, or undefined to keep it.
   */
  private async rejection(packageName: string): Promise<string | undefined> {
    let probe: PluginProbe
    try {
      probe = await this.probe(packageName)
    } catch {
      return undefined // the failure is re-derived on every list and shown there
    }
    // A refused probe (an import that throws, another cordis copy) keeps the
    // package: the view shows it as not enableable with the probe's reason.
    if (!probe.ok) return undefined
    if (probe.kind === 'library') return 'declares neither a dsh bundle nor a plugin module'
    if (probe.kind !== 'bundle') return undefined
    const { profileDir, installAnchor } = this.options
    try {
      const layer = resolveProfileLayer(NAME, readProfileManifest(NAME, profileDir), packageName, installAnchor, profileDir)
      const lost = claimLayerIds([...this.options.loadProfile().layers, layer]).skipped.get(packageName)
      if (lost === undefined) return undefined
      return lost.map(conflict => `row ${JSON.stringify(conflict.rowId)} is already declared by ${conflict.declaredBy}`).join('; ')
    } catch (error) {
      return messageOf(error)
    }
  }

  /**
   * Run one pnpm command in the profile directory, streaming its output as
   * install-log chunks.
   * @returns the run's job id.
   * @throws {PluginOperationError} `plugins/install-failed` on a non-zero exit, a signal, or the timeout.
   */
  private async runPnpm(args: readonly string[], spec: string): Promise<string> {
    const { config, profileDir } = this.options
    const jobId = randomUUID()
    const tail: string[] = []
    let tailBytes = 0
    const record = (stream: 'stdout' | 'stderr', text: string): void => {
      tail.push(text)
      tailBytes += Buffer.byteLength(text)
      while (tailBytes > config.installLogTailBytes && tail.length > 1) {
        tailBytes -= Buffer.byteLength(tail.shift() as string)
      }
      this.options.installLog({ jobId, spec, stream, text })
    }
    // Windows resolves pnpm through its .cmd shim, which spawn() refuses
    // without a shell since the CVE-2024-27980 hardening. The parent
    // environment is passed whole, as the `dsh plugin` command does: pnpm
    // needs the user's registry, proxy, and auth settings.
    const child = this.spawn(config.pnpmCommand, args, {
      cwd: profileDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: process.env,
    })
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (text: string) => { record('stdout', text) })
    child.stderr?.on('data', (text: string) => { record('stderr', text) })
    const exitCode = await awaitChildClose(
      child, config.installTimeoutMs,
      () => new Error(`${NAME}: pnpm ${args.join(' ')} timed out after ${String(config.installTimeoutMs)}ms`),
    ).catch((error: unknown) => {
      const message = messageOf(error)
      record('stderr', `${message}\n`)
      this.options.installLog({ jobId, spec, stream: 'stderr', text: '', exitCode: null })
      throw new PluginOperationError('plugins/install-failed', `${NAME}: ${message}`, { spec, exitCode: null, log: tail.join('') }, { cause: error })
    })
    this.options.installLog({ jobId, spec, stream: 'stdout', text: '', exitCode })
    if (exitCode !== 0) {
      throw new PluginOperationError(
        'plugins/install-failed',
        `${NAME}: pnpm ${args.join(' ')} exited with ${String(exitCode)} in ${profileDir}`,
        { spec, exitCode, log: tail.join('') },
      )
    }
    return jobId
  }
}

/**
 * Plugin management over the booted profile: every operation the `plugins`
 * Remote exposes, with the tree read through the Cordis context and the
 * profile runtime, the preset roster, and the running-agent count read
 * through {@link PluginManagerOptions} per call.
 *
 * Every write touches the profile manifest, the user layers, or
 * `node_modules`, and two at once would race on those files, so the manager
 * runs one mutation at a time and refuses a second rather than queueing it.
 * Every change is followed by a `plugins/changed` event on the context.
 */
export class PluginManager {
  /** The mutation in flight, while one is; a second caller is refused rather than queued. */
  private active: { operation: string; subject: string } | undefined

  /**
   * @param ctx - the context whose Loader tree and services the operations read.
   * @param options - the profile runtime, the roster, the agent count, and the tooling bounds.
   */
  constructor(private readonly ctx: Context, private readonly options: PluginManagerOptions) {}

  /**
   * Run one mutation with the manager to itself.
   * @throws {PluginOperationError} `plugins/busy` naming the operation in flight.
   */
  private async exclusive<T>(operation: string, subject: string, run: () => Promise<T>): Promise<T> {
    if (this.active !== undefined) {
      throw new PluginOperationError(
        'plugins/busy',
        `${NAME}: ${operation} ${subject} refused while ${this.active.operation} ${this.active.subject} is still running`,
        { operation, subject, active: this.active },
      )
    }
    this.active = { operation, subject }
    try {
      return await run()
    } finally {
      this.active = undefined
    }
  }

  /**
   * Refuse a change to `node_modules` while a session is running: pnpm
   * rewrites the directory the running agents import from.
   * @throws {PluginOperationError} `plugins/agents-running` with the count.
   */
  private assertNoRunningAgents(operation: string): void {
    const running = this.options.runningAgents()
    if (running === 0) return
    throw new PluginOperationError(
      'plugins/agents-running',
      `${NAME}: ${operation} waits for ${String(running)} running session(s) to go idle`,
      { operation, running },
    )
  }

  /** The profile runtime, or the failure a caller without one receives. */
  private runtime(): ProfileRuntime {
    const runtime = this.options.runtime()
    if (runtime === undefined) {
      throw new PluginOperationError(
        'plugins/unavailable',
        `${NAME}: no profile is composed in this process, so there are no plugins to manage`,
        { reason: 'no profile runtime' },
      )
    }
    return runtime
  }

  /** The installer over the booted profile, streaming pnpm's output as `plugins/install-log`. */
  private installer(runtime: ProfileRuntime): PluginInstaller {
    return new PluginInstaller({
      profileDir: runtime.dir,
      profileName: runtime.profileName,
      installAnchor: runtime.installAnchor,
      loadProfile: () => runtime.current,
      config: this.options.config,
      installLog: (chunk) => { this.ctx.emit('plugins/install-log', chunk) },
      ...this.options.spawn === undefined ? {} : { spawn: this.options.spawn },
      ...this.options.probe === undefined ? {} : { probe: this.options.probe },
    })
  }

  /**
   * Every package the profile knows: its template and installed bundles,
   * and every other installed dependency.
   * @returns one view per package, bundles first in layer order.
   */
  async list(): Promise<PluginPackageView[]> {
    const runtime = this.runtime()
    const installer = this.installer(runtime)
    const manifest = readProfileManifest(NAME, runtime.dir)
    const names = [...new Set([...bundlesOf(manifest), ...Object.keys(dependenciesOf(manifest))])]
    const views: PluginPackageView[] = []
    for (const name of names) views.push(await this.view(runtime, installer, manifest, name))
    return views
  }

  /** Fold one package's manifest, probe, and tree facts into its view. */
  private async view(
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
    const rows = composed ? this.composedRows(runtime, name) : this.probedRows(probe)
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
  private probedRows(probe: PluginProbe | undefined): PluginPackageRowView[] {
    return (probe?.rows ?? []).map(row => ({
      entryId: row.id ?? row.name,
      rowId: row.id ?? row.name,
      moduleName: row.name,
      enabled: !row.gated,
      ...row.gated ? { disabledBy: 'composition' as const } : {},
      phase: null,
    }))
  }

  /**
   * Install a package into the profile with pnpm, probe it, and leave it
   * disabled unless asked otherwise. The run's output is emitted as
   * `plugins/install-log` chunks carrying the returned `jobId`.
   * @param spec - what to install, in pnpm's own vocabulary: a registry
   * name, a `github:` or git URL, a tarball, or an absolute path.
   * @param options - `enable` puts every newly installed bundle into the layer list at once.
   * @returns what the run installed and enabled.
   * @throws {PluginOperationError} `plugins/agents-running` while a session
   * runs, `plugins/install-failed` when pnpm exits non-zero or the run times
   * out, `plugins/enable-failed` when enabling was asked for and the tree
   * rejected the bundle.
   */
  async add(spec: string, options?: { enable?: boolean }): Promise<PluginInstallResult> {
    return this.exclusive('add', spec, () => this.addNow(spec, options))
  }

  private async addNow(spec: string, options?: { enable?: boolean }): Promise<PluginInstallResult> {
    const runtime = this.runtime()
    this.assertNoRunningAgents('add')
    const outcome = await this.installer(runtime).add(spec)
    const enabled: string[] = []
    if (options?.enable === true) {
      for (const name of outcome.installedOnly) {
        await this.enableNow(name)
        enabled.push(name)
      }
    }
    this.changed('install')
    return {
      ...outcome,
      enabled,
      installedOnly: outcome.installedOnly.filter(name => !enabled.includes(name)),
    }
  }

  /**
   * Remove a package from the profile: disable it when enabled, drop every
   * user-layer row that names it, run `pnpm remove`, and forget its probe.
   * @param packageName - the installed dependency to remove.
   * @throws {PluginOperationError} `plugins/not-installed`, `plugins/agents-running`,
   * or `plugins/install-failed` when pnpm exits non-zero.
   */
  async uninstall(packageName: string): Promise<void> {
    return this.exclusive('uninstall', packageName, () => this.uninstallNow(packageName))
  }

  private async uninstallNow(packageName: string): Promise<void> {
    const runtime = this.runtime()
    const installer = this.installer(runtime)
    installer.assertInstalled(packageName)
    this.assertNoRunningAgents('uninstall')
    const references = await this.rowReferences(runtime, packageName)
    if (bundlesOf(readProfileManifest(NAME, runtime.dir)).includes(packageName)) {
      await this.disableNow(packageName)
    }
    for (const reference of references) {
      await this.editLayer(runtime, reference.target, (document) => { document.removeInsert(reference.rowId) })
    }
    await installer.remove(packageName)
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
   * @throws {PluginOperationError} `plugins/not-installed`, `plugins/not-enableable`
   * for a package that declares no bundle or whose probe refused it, or
   * `plugins/enable-failed`.
   */
  async enable(packageName: string): Promise<PluginEnableResult> {
    return this.exclusive('enable', packageName, () => this.enableNow(packageName))
  }

  private async enableNow(packageName: string): Promise<PluginEnableResult> {
    const runtime = this.runtime()
    const installer = this.installer(runtime)
    installer.assertInstalled(packageName)
    const probe = await installer.probe(packageName).catch((error: unknown) => {
      const reason = `cannot be probed: ${messageOf(error)}`
      throw new PluginOperationError('plugins/not-enableable', `${NAME}: ${packageName} ${reason}`, { packageName, reason })
    })
    if (!probe.ok) {
      // The probe states a reason with every refusal; the fallback keeps the type total.
      /* v8 ignore next */
      const reason = probe.reason ?? 'the probe refused it'
      throw new PluginOperationError('plugins/not-enableable', `${NAME}: ${packageName} cannot be enabled: ${reason}`, { packageName, reason })
    }
    let changed: boolean
    try {
      changed = enableBundle(NAME, runtime.dir, runtime.installAnchor, packageName)
    } catch (error) {
      const reason = messageOf(error)
      throw new PluginOperationError('plugins/not-enableable', reason, { packageName, reason })
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
        throw new PluginOperationError(
          'plugins/enable-failed',
          `${NAME}: enabling ${packageName} failed and the layer list was restored: ${reason}`,
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
   * @throws {PluginOperationError} `plugins/bad-request` for a template bundle, which is not a dependency.
   */
  async disable(packageName: string): Promise<PluginEnableResult> {
    return this.exclusive('disable', packageName, () => this.disableNow(packageName))
  }

  private async disableNow(packageName: string): Promise<PluginEnableResult> {
    const runtime = this.runtime()
    let changed: boolean
    try {
      changed = disableBundle(NAME, runtime.dir, packageName)
    } catch (error) {
      throw new PluginOperationError('plugins/bad-request', messageOf(error), {}, { cause: error })
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
   * @throws {PluginOperationError} `plugins/bad-request` when the bundle is not enabled, or the enable failures.
   */
  async retry(packageName: string): Promise<PluginEnableResult> {
    return this.exclusive('retry', packageName, () => this.retryNow(packageName))
  }

  private async retryNow(packageName: string): Promise<PluginEnableResult> {
    const runtime = this.runtime()
    if (!bundlesOf(readProfileManifest(NAME, runtime.dir)).includes(packageName)) {
      throw new PluginOperationError('plugins/bad-request', `${NAME}: ${packageName} is not enabled`, {})
    }
    await this.disableNow(packageName)
    const result = await this.enableNow(packageName)
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
   * @throws {PluginOperationError} `plugins/not-installed`, `plugins/not-enableable`
   * when the module is not one the probe found addable, `plugins/row-conflict`,
   * or `plugins/unavailable` for a preset target without a roster.
   */
  async addRow(
    packageName: string,
    target: PluginRowTarget,
    options?: { module?: string; id?: string; config?: JsonValue },
  ): Promise<PluginRowAddition> {
    return this.exclusive('addRow', packageName, () => this.addRowNow(packageName, target, options))
  }

  private async addRowNow(
    packageName: string,
    target: PluginRowTarget,
    options?: { module?: string; id?: string; config?: JsonValue },
  ): Promise<PluginRowAddition> {
    const runtime = this.runtime()
    const installer = this.installer(runtime)
    installer.assertInstalled(packageName)
    const probe = await installer.probe(packageName)
    const declared = options?.module ?? '.'
    const addable = declared === '.' && probe.kind === 'plugin'
      ? { ok: true, config: undefined, error: undefined }
      : probe.addable.find(entry => entry.name === declared)
    if (addable === undefined || !addable.ok) {
      const reason = addable?.error ?? `${declared} is not a module ${packageName} declares addable`
      throw new PluginOperationError('plugins/not-enableable', `${NAME}: ${reason}`, { packageName, reason })
    }
    const moduleName = moduleSpecifier(packageName, declared)
    const rowId = options?.id ?? derivedRowId(packageName, declared)
    const row: PatchRow = { id: rowId, name: moduleName, config: options?.config ?? addable.config ?? {} }
    if (await this.rowExists(runtime, target, rowId)) {
      throw new PluginOperationError('plugins/row-conflict', `${NAME}: a row ${JSON.stringify(rowId)} already exists`, { rowId, target })
    }
    const file = await this.editLayer(runtime, target, (document) => { document.appendInsert(row) })
    this.changed('row', packageName)
    return { target, rowId, file }
  }

  /**
   * Remove a row a user layer inserted.
   * @param target - which layer.
   * @param rowId - the inserted row's id.
   * @throws {PluginOperationError} `plugins/bad-request` when the layer inserts no such row.
   */
  async removeRow(target: PluginRowTarget, rowId: string): Promise<void> {
    return this.exclusive('removeRow', rowId, () => this.removeRowNow(target, rowId))
  }

  private async removeRowNow(target: PluginRowTarget, rowId: string): Promise<void> {
    const runtime = this.runtime()
    // A holder rather than a `let`: the assignment happens inside the edit
    // callback, which control-flow narrowing does not see.
    const outcome = { removed: false }
    await this.editLayer(runtime, target, (document) => { outcome.removed = document.removeInsert(rowId) })
    if (!outcome.removed) {
      throw new PluginOperationError('plugins/bad-request', `${NAME}: the layer inserts no row ${JSON.stringify(rowId)}`, {})
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
  async setRowDisabled(target: PluginRowTarget, rowId: string, disabled: boolean): Promise<void> {
    return this.exclusive('setRowDisabled', rowId, () => this.setRowDisabledNow(target, rowId, disabled))
  }

  private async setRowDisabledNow(target: PluginRowTarget, rowId: string, disabled: boolean): Promise<void> {
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
    const presets = this.options.presets()
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
    const composition = (await this.presets().compositionInventory()).find(candidate => candidate.id === target.preset)
    return composition?.rows.some(row => row.entryId === rowId) ?? false
  }

  /** The roster's layers, or the failure a preset target without a roster receives. */
  private presets(): PresetLayers {
    const presets = this.options.presets()
    if (presets === undefined) {
      throw new PluginOperationError('plugins/unavailable', `${NAME}: no agent-preset roster is composed`, { reason: 'no roster' })
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

/** The wire view of one probed addable module. */
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
