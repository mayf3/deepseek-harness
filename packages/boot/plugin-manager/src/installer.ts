/**
 * Installing and removing packages with pnpm and reading static declarations
 * from the profile on disk: nothing here touches a running tree, which
 * is what lets the `dsh plugin` command install before any plugin starts.
 * @module @deepseek-ai/dsh-plugin-manager/installer
 */

import { spawn as spawnChild } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import type { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { spawnSubprocess } from '@deepseek-ai/dsh-subprocess-local/spawn'
import { join } from 'node:path'
import {
  claimLayerIds,
  healProfilesModuleFallback,
  readPackageMetadata,
  readProfileManifest,
  reconcileInstalledBundles,
  resolveBundleDir,
  resolveProfileLayer,
  type PackageMetadata,
  type Profile,
  type ProfileManifest,
} from '@deepseek-ai/dsh-app-boot'
import { PluginOperationError } from './errors.ts'
import { dependenciesOf, messageOf, NAME, type PluginToolingConfig, type SpawnLike } from './helpers.ts'
import type { PluginInstallLogChunk, PluginInstallRejection, PluginInstallResult, PluginInstallRequestId } from './types.ts'

/** The manager owns cancellation until prepared transfers control to runtime application. */
export interface PluginInstallControl {
  readonly requestId: PluginInstallRequestId
  readonly signal: AbortSignal
  readonly prepared?: () => void
}

/** Check cancellation between subprocesses and before committing the installation. */
function checkCancelled(control?: PluginInstallControl): void {
  if (control?.signal.aborted) {
    throw new PluginOperationError('plugins/install-cancelled', `${NAME}: installation cancelled`, { requestId: control.requestId })
  }
}

/** Read an optional pnpm lockfile without hiding unreadable-file failures. */
function readLockfile(path: string): Buffer | undefined {
  try { return readFileSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

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
  /** Test seam: the static metadata reader; defaults to app-boot’s. */
  readonly metadata?: typeof readPackageMetadata
}

/** The installed package's manifest slice the view reads. */
export type InstalledManifest = ProfileManifest & { description?: string; dsh?: ProfileManifest['dsh'] & { title?: string } }

/**
 * Installs and removes packages in one profile with pnpm, and reads their declarations.
 *
 * Every run reads the profile manifest afresh and writes it through the
 * app-boot helpers the `dsh plugin` command uses, so the CLI and the Web
 * host never disagree on the file: `dependencies` records what is installed,
 * `dsh.profile.bundles` what is enabled. No operation here touches a running
 * tree, so the CLI can install before any plugin starts.
 */
export class PluginInstaller {
  private readonly spawn: SpawnLike
  private readonly metadataReader: typeof readPackageMetadata

  /**
   * @param options - the profile, the tooling bounds, and the output sink.
   */
  constructor(private readonly options: PluginInstallerOptions) {
    this.spawn = options.spawn ?? (spec => spawnSubprocess(spec, {
      // Windows pnpm is normally a .cmd shim; retain the CLI's shell resolution.
      spawn: (command, args, options) => spawnChild(command, [...args], { ...options, shell: process.platform === 'win32' }),
    }))
    this.metadataReader = options.metadata ?? readPackageMetadata
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
   * Read the installed manifest and patch without executing modules or caching runtime verdicts.
   * @param packageName - the installed package.
   * @returns its current static declarations.
   */
  metadata(packageName: string): PackageMetadata {
    return this.metadataReader({
      binName: NAME, profileDir: this.options.profileDir,
      installAnchor: this.options.installAnchor, packageName,
    })
  }

  /**
   * Install with pnpm and reject bundles whose declarations conflict with the profile.
   * Undeclared packages remain installed; new bundles are left disabled.
   * @param spec - what to install, in pnpm's own vocabulary: a registry
   * name, a `github:` or git URL, a tarball, or an absolute path.
   * @param control - optional cancellation and the handoff to runtime application.
   * @returns what the run installed and what it removed again.
   * @throws {PluginOperationError} `plugins/bad-request` for an empty spec,
   * `plugins/install-failed` when pnpm exits non-zero, cannot be spawned, or times out;
   * `plugins/install-cancelled` after cancellation and manifest/lockfile restoration.
   */
  async add(spec: string, control?: PluginInstallControl): Promise<PluginInstallOutcome> {
    if (spec.trim().length === 0) {
      throw new PluginOperationError('plugins/bad-request', `${NAME}: the package spec must not be empty`, {})
    }
    const { profileDir, installAnchor } = this.options
    const manifestPath = join(profileDir, 'package.json')
    const snapshot = readFileSync(manifestPath)
    const lockPath = join(profileDir, 'pnpm-lock.yaml')
    const lock = readLockfile(lockPath)
    const before = readProfileManifest(NAME, profileDir)
    try {
      checkCancelled(control)
      const jobId = await this.runPnpm(['add', spec], spec, control)
      const outcome = reconcileInstalledBundles(NAME, profileDir, installAnchor, before, { autoEnable: false })
      const after = readProfileManifest(NAME, profileDir)
      const added = Object.keys(dependenciesOf(after)).filter(name => !(name in dependenciesOf(before)))
      await healProfilesModuleFallback({ installAnchor, profile: this.options.loadProfile() })
      checkCancelled(control)
      const installed: string[] = []
      const removed: PluginInstallRejection[] = []
      for (const name of added) {
        const reason = this.rejection(name)
        if (reason === undefined) {
          installed.push(name)
          continue
        }
        await this.remove(name, control)
        removed.push({ name, reason })
      }
      checkCancelled(control)
      control?.prepared?.()
      const kept = new Set(installed)
      return {
        installed,
        removed,
        installedOnly: outcome.installedOnly.filter(name => kept.has(name)),
        plain: outcome.plain.filter(name => kept.has(name)),
        jobId,
      }
    } catch (error) {
      // The child and its process group have stopped before these files are restored.
      // node_modules and the pnpm store are not a transactional snapshot.
      writeFileSync(manifestPath, snapshot)
      if (lock === undefined) rmSync(lockPath, { force: true })
      else writeFileSync(lockPath, lock)
      throw error
    }
  }

  /**
   * Run `pnpm remove` and reconcile the layer list.
   * @param packageName - the dependency to remove.
   * @param control - optional cancellation for this package operation.
   * @throws {PluginOperationError} `plugins/install-failed` when pnpm fails.
   */
  async remove(packageName: string, control?: PluginInstallControl): Promise<void> {
    const { profileDir, installAnchor } = this.options
    const before = readProfileManifest(NAME, profileDir)
    await this.runPnpm(['remove', packageName], packageName, control)
    reconcileInstalledBundles(NAME, profileDir, installAnchor, before, { autoEnable: false })
  }

  /**
   * Check a new bundle against the profile’s row ownership rules.
   * Undeclared or unreadable packages remain installed for repair or removal.
   * @returns why the package is removed again, or undefined to keep it.
   */
  private rejection(packageName: string): string | undefined {
    let metadata: PackageMetadata
    try {
      metadata = this.metadata(packageName)
    } catch {
      return undefined // Keep unreadable declarations installed so the user can repair or remove the package.
    }
    if (metadata.kind !== 'bundle') return undefined
    const { profileDir, installAnchor } = this.options
    try {
      const layer = resolveProfileLayer(NAME, packageName, installAnchor, profileDir)
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
  private async runPnpm(args: readonly string[], spec: string, control?: PluginInstallControl): Promise<string> {
    const { color, config, profileDir } = this.options
    const jobId = randomUUID()
    const argv = [config.pnpmCommand, ...args]
    const request = control === undefined ? {} : { requestId: control.requestId }
    const tail: string[] = []
    let tailBytes = 0
    const record = (stream: 'stdout' | 'stderr', chunk: string): void => {
      const text = color ? chunk : chunk.replace(ANSI_SEQUENCE, '')
      tail.push(text)
      tailBytes += Buffer.byteLength(text)
      while (tailBytes > config.installLogTailBytes && tail.length > 1) {
        tailBytes -= Buffer.byteLength(tail.shift() as string)
      }
      this.options.installLog({ ...request, jobId, argv, cwd: profileDir, spec, stream, text })
    }
    const deadline = new AbortController()
    const signal = control === undefined ? deadline.signal : AbortSignal.any([deadline.signal, control.signal])
    const timer = setTimeout(() => { deadline.abort() }, config.installTimeoutMs)
    let exitCode: number | null = null
    try {
      checkCancelled(control)
      const child = this.spawn({
        argv, cwd: profileDir, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs: config.installKillGraceMs, signal,
        // Preserve registry, proxy and authentication settings, including pnpm credentials.
        env: { ...process.env, FORCE_COLOR: color ? '1' : '0' },
      })
      // Both outputs were requested as pipes; their presence follows the subprocess contract.
      const stdout = child.stdout as Readable
      const stderr = child.stderr as Readable
      const drains = [finished(stdout), finished(stderr)]
      stdout.setEncoding('utf8')
      stderr.setEncoding('utf8')
      stdout.on('data', (text: string) => { record('stdout', text) })
      stderr.on('data', (text: string) => { record('stderr', text) })
      try {
        const [outcome] = await Promise.all([child.done, ...drains])
        exitCode = outcome.exitCode
      } finally {
        // Cancellation starts termination; this separate wait confirms the owned range is empty.
        await child.waitForExit()
      }
      checkCancelled(control)
      if (deadline.signal.aborted) throw new Error(`${NAME}: pnpm ${args.join(' ')} timed out after ${String(config.installTimeoutMs)}ms`)
    } catch (error) {
      const message = messageOf(error)
      record('stderr', `${message}\n`)
      this.options.installLog({ ...request, jobId, argv, cwd: profileDir, spec, stream: 'stderr', text: '', exitCode })
      if (error instanceof PluginOperationError && error.code === 'plugins/install-cancelled') throw error
      throw new PluginOperationError('plugins/install-failed', `${NAME}: ${message}`, { spec, exitCode, log: tail.join('') }, { cause: error })
    } finally {
      clearTimeout(timer)
    }
    this.options.installLog({ ...request, jobId, argv, cwd: profileDir, spec, stream: 'stdout', text: '', exitCode })
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
