/**
 * Installing and removing packages in one profile with pnpm, and probing
 * them, over the profile on disk: nothing here touches a running tree, which
 * is what lets the `dsh plugin` command install before any plugin starts.
 * @module @deepseek-ai/dsh-plugin-manager/installer
 */

import { spawn as spawnChild } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  awaitChildClose,
  claimLayerIds,
  healProfilesModuleFallback,
  PLUGIN_PROBE_DIR,
  probePackage,
  readProbeCache,
  readProfileManifest,
  reconcileInstalledBundles,
  resolveBundleDir,
  resolveProfileLayer,
  writeProbeCache,
  type PluginProbe,
  type Profile,
  type ProfileManifest,
} from '@deepseek-ai/dsh-app-boot'
import { PluginOperationError } from './errors.ts'
import { dependenciesOf, messageOf, NAME, type PluginToolingConfig, type SpawnLike } from './helpers.ts'
import type { PluginInstallLogChunk, PluginInstallRejection, PluginInstallResult } from './types.ts'

/** What one install run changed before any newly installed bundle was enabled. */
export type PluginInstallOutcome = Omit<PluginInstallResult, 'enabled'>

/** A terminal escape sequence (CSI): colours, cursor moves, and the rest of what a coloured pnpm prints. */
const ANSI_SEQUENCE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

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
  /**
   * Whether pnpm colours its output. On, the chunks carry SGR escapes for a
   * consumer that draws them (the Web install dialog's terminal); off, they
   * are plain text, with the escapes a pnpm told to colour anyway prints
   * (a `color=always` config) dropped.
   */
  readonly color: boolean
  /** Test seam: the child spawner; defaults to `node:child_process`. */
  readonly spawn?: SpawnLike
  /** Test seam: the package probe; defaults to app-boot's. */
  readonly probe?: typeof probePackage
}

/** The installed package's manifest slice the view reads. */
export type InstalledManifest = ProfileManifest & { description?: string; dsh?: ProfileManifest['dsh'] & { title?: string } }

/**
 * Installs and removes packages in one profile with pnpm, and probes them.
 *
 * Every run reads the profile manifest afresh and writes it through the
 * app-boot helpers the `dsh plugin` command uses, so the CLI and the Web
 * host never disagree on the file: `dependencies` records what is installed,
 * `dsh.profile.bundles` what is enabled, and `dsh.profile.disabledBundles`
 * what the user turned off. Nothing here touches a running tree, which is
 * what lets the CLI install before any plugin starts.
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
    const { color, config, profileDir } = this.options
    const jobId = randomUUID()
    const argv = [config.pnpmCommand, ...args]
    const tail: string[] = []
    let tailBytes = 0
    const record = (stream: 'stdout' | 'stderr', chunk: string): void => {
      const text = color ? chunk : chunk.replace(ANSI_SEQUENCE, '')
      tail.push(text)
      tailBytes += Buffer.byteLength(text)
      while (tailBytes > config.installLogTailBytes && tail.length > 1) {
        tailBytes -= Buffer.byteLength(tail.shift() as string)
      }
      this.options.installLog({ jobId, argv, cwd: profileDir, spec, stream, text })
    }
    // Windows resolves pnpm through its .cmd shim, which spawn() refuses
    // without a shell since the CVE-2024-27980 hardening. The parent
    // environment is passed whole, as the `dsh plugin` command does: pnpm
    // needs the user's registry, proxy, and auth settings. pnpm writes to a
    // pipe and would decide against colour on its own, so `FORCE_COLOR`
    // decides for it either way: a parent forcing colours for its own
    // terminal cannot leak escapes into a plain log.
    const child = this.spawn(config.pnpmCommand, args, {
      cwd: profileDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: { ...process.env, FORCE_COLOR: color ? '1' : '0' },
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
      this.options.installLog({ jobId, argv, cwd: profileDir, spec, stream: 'stderr', text: '', exitCode: null })
      throw new PluginOperationError('plugins/install-failed', `${NAME}: ${message}`, { spec, exitCode: null, log: tail.join('') }, { cause: error })
    })
    this.options.installLog({ jobId, argv, cwd: profileDir, spec, stream: 'stdout', text: '', exitCode })
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
