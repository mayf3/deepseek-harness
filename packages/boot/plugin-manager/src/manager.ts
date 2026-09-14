/**
 * Plugin management over the booted profile: every operation the `plugins`
 * Remote exposes, one mutation at a time, with the tree read through the
 * Cordis context and the profile runtime and the
 * running-agent count read through per-call readers.
 * @module @deepseek-ai/dsh-plugin-manager/manager
 */

import { randomUUID } from 'node:crypto'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import {
  disableBundle,
  enableBundle,
  healProfilesModuleFallback,
  loadProfile,
  readProfileManifest,
  inspectEntryIssues,
  type EntryIssue,
  type readPackageMetadata,
  type ProfileRuntime,
} from '@deepseek-ai/dsh-app-boot'
import { mutatePatchFile, readPatchListFile, type PatchRow } from '@deepseek-ai/dsh-app-boot/patch-file'
import { PluginOperationError } from './errors.ts'
import { bundlesOf, dependenciesOf, messageOf, NAME, optional, type PluginToolingConfig, type SpawnLike } from './helpers.ts'
import { PluginInstaller, type PluginInstallControl } from './installer.ts'
import type {
  PluginChangeReason,
  PluginDependents,
  PluginEnableResult,
  PluginInstallResult,
  PluginInstallOptions,
  PluginInstallRequestId,
  PluginInstallProgress,
  PluginInstallCancellation,
  PluginPackageView,
  PluginRowIssue,
  PluginRowReference,
  PluginServiceDependent,
} from './types.ts'
import { ownedEntries, packageView } from './view.ts'

/** The manager retains only its current installation, not a task history. */
interface ActiveInstall {
  readonly requestId: PluginInstallRequestId
  readonly controller: AbortController
  readonly settled: Promise<void>
  readonly finish: () => void
  phase: PluginInstallProgress['phase']
  failure?: unknown
}

/** One manifest or runtime mutation, with cancellation only for installation. */
interface ActiveMutation {
  readonly operation: string
  readonly subject: string
  install?: ActiveInstall
  stopFiles?: () => Promise<void>
}

/** What {@link PluginManager} needs beyond the Cordis context it reads the tree through. */
export interface PluginManagerOptions {
  readonly config: PluginToolingConfig
  /** The booted profile, read per call; `undefined` means no profile is composed in this process. */
  readonly runtime: () => ProfileRuntime | undefined
  /** How many agents are running; `add` and `uninstall` refuse while any is. */
  readonly runningAgents: () => number
  /** Test seam: the child spawner; defaults to `node:child_process`. */
  readonly spawn?: SpawnLike
  /** Test seam: the static metadata reader; defaults to app-boot’s. */
  readonly metadata?: typeof readPackageMetadata
}

/**
 * Plugin management over the booted profile: every operation the `plugins`
 * Remote exposes, with the tree read through the Cordis context and the
 * profile runtime and the running-agent count read
 * through {@link PluginManagerOptions} per call.
 *
 * Every write touches the profile manifest, the user layers, or
 * `node_modules`, and two at once would race on those files, so the manager
 * runs one mutation at a time and refuses a second rather than queueing it.
 * Every change is followed by a `plugins/changed` event on the context.
 */
export class PluginManager {
  /** The mutation in flight, while one is; a second caller is refused rather than queued. */
  private active: ActiveMutation | undefined
  private disposed = false

  /**
   * @param ctx - the context whose Loader tree and services the operations read.
   * @param options - the profile runtime, the agent count, and the tooling bounds.
   */
  constructor(private readonly ctx: Context, private readonly options: PluginManagerOptions) {
    ctx.effect(() => async () => {
      this.disposed = true
      const install = this.active?.install
      // Runtime application may itself unload this plugin; never join that recompose from its disposer.
      if (install !== undefined && install.phase !== 'applying') await this.cancelInstall(install.requestId)
      else await this.active?.stopFiles?.()
    })
  }

  /**
   * Run one mutation with the manager to itself.
   * @throws {PluginOperationError} `plugins/busy` naming the operation in flight.
   */
  private async exclusive<T>(operation: string, subject: string, run: (active: ActiveMutation) => Promise<T>): Promise<T> {
    if (this.active !== undefined) {
      throw new PluginOperationError(
        'plugins/busy',
        `${NAME}: ${operation} ${subject} refused while ${this.active.operation} ${this.active.subject} is still running`,
        { operation, subject, active: { operation: this.active.operation, subject: this.active.subject } },
      )
    }
    const active: ActiveMutation = { operation, subject }
    this.active = active
    try {
      return await run(active)
    } finally {
      this.active = undefined
      active.install?.finish()
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
      // The chunks feed the Web install dialog's terminal, which draws SGR colour.
      color: true,
      ...this.options.spawn === undefined ? {} : { spawn: this.options.spawn },
      ...this.options.metadata === undefined ? {} : { metadata: this.options.metadata },
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
    const issues = await inspectEntryIssues(this.ctx)
    for (const name of names) views.push(packageView(this.ctx, runtime, installer, manifest, name, issues))
    return views
  }


  /**
   * Install a package into the profile with pnpm, read its declarations, and leave it
   * disabled unless asked otherwise. The run's output is emitted as
   * `plugins/install-log` chunks carrying the returned `jobId`.
   * @param spec - what to install, in pnpm's own vocabulary: a registry
   * name, a `github:` or git URL, a tarball, or an absolute path.
   * @param options - `enable` selects new bundles; `requestId` identifies the install for progress and cancellation.
   * @returns what the run installed and enabled.
   * @throws {PluginOperationError} `plugins/agents-running` while a session
   * runs, `plugins/install-failed` when pnpm exits non-zero or the run times
   * out, `plugins/enable-failed` when enabling was asked for and the tree
   * rejected the bundle.
   */
  async add(spec: string, options?: PluginInstallOptions): Promise<PluginInstallResult> {
    return this.exclusive('add', spec, async (active) => {
      const { promise, resolve } = Promise.withResolvers<void>()
      const install: ActiveInstall = {
        requestId: options?.requestId ?? randomUUID() as PluginInstallRequestId,
        controller: new AbortController(), settled: promise, finish: resolve, phase: 'installing',
      }
      active.install = install
      this.installProgress(install)
      try {
        return await this.addNow(spec, options, {
          requestId: install.requestId, signal: install.controller.signal,
          prepared: () => { install.phase = 'applying'; this.installProgress(install) },
        })
      } catch (error) {
        install.failure = error
        throw error
      }
    })
  }

  /**
   * Stop the matching installation and wait for its file recovery and mutation lock release.
   * @param requestId - the installation the caller started; never selects another active operation.
   * @returns cancelled after cleanup, too-late during application, or not-running for an unmatched request.
   * @throws {PluginOperationError} when the installation fails instead of completing cancellation.
   */
  async cancelInstall(requestId: PluginInstallRequestId): Promise<PluginInstallCancellation> {
    const install = this.active?.install
    if (install?.requestId !== requestId) return { status: 'not-running' }
    if (install.phase === 'applying') return { status: 'too-late' }
    if (install.phase !== 'cancelling') {
      install.phase = 'cancelling'
      this.installProgress(install)
      install.controller.abort()
    }
    await install.settled
    if (install.failure instanceof PluginOperationError && install.failure.code === 'plugins/install-cancelled') {
      return { status: 'cancelled' }
    }
    throw install.failure
  }

  private installProgress(install: ActiveInstall): void {
    if (this.disposed) return
    this.ctx.emit('plugins/install-state', { requestId: install.requestId, phase: install.phase })
  }

  private async addNow(
    spec: string, options: PluginInstallOptions | undefined, control: PluginInstallControl,
  ): Promise<PluginInstallResult> {
    const runtime = this.runtime()
    this.assertNoRunningAgents('add')
    const outcome = await this.installer(runtime).add(spec, control)
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
   * user-layer row that names it, and run `pnpm remove`.
   * @param packageName - the installed dependency to remove.
   * @throws {PluginOperationError} `plugins/not-installed`, `plugins/agents-running`,
   * or `plugins/install-failed` when pnpm exits non-zero.
   */
  async uninstall(packageName: string): Promise<void> {
    return this.exclusive('uninstall', packageName, active => this.uninstallNow(packageName, active))
  }

  private async uninstallNow(packageName: string, active: ActiveMutation): Promise<void> {
    const runtime = this.runtime()
    const installer = this.installer(runtime)
    installer.assertInstalled(packageName)
    this.assertNoRunningAgents('uninstall')
    const references = await this.rowReferences(runtime, packageName)
    if (bundlesOf(readProfileManifest(NAME, runtime.dir)).includes(packageName)) {
      await this.disableNow(packageName)
    }
    for (const reference of references) {
      await this.editLayer(runtime, (document) => { document.removeInsert(reference.rowId) })
    }
    if (this.disposed) {
      throw new PluginOperationError('plugins/unavailable', `${NAME}: manager was disposed before package removal`, { reason: 'manager disposed' })
    }
    const controller = new AbortController()
    const settled = Promise.withResolvers<undefined>()
    active.stopFiles = async () => { controller.abort(); await settled.promise }
    try {
      await installer.remove(packageName, {
        requestId: randomUUID() as PluginInstallRequestId, signal: controller.signal,
      })
    } finally {
      delete active.stopFiles
      settled.resolve(undefined)
    }
    if (references.length > 0 && runtime.patchReload === 'live') {
      await runtime.recompose()
    }
    this.changed('uninstall', packageName)
  }

  /**
   * Put an installed bundle into the layer list and, on a live profile,
   * recompose the tree. Per-row failures retain enabled selection and successful siblings.
   * Preparation failures revert enable selection and report their reason.
   * @param packageName - the installed bundle.
   * @returns whether the list changed and whether the change is live.
   * @throws {PluginOperationError} `plugins/not-installed`, `plugins/not-enableable`
   * for a package without a readable bundle declaration, or
   * `plugins/enable-failed`.
   */
  async enable(packageName: string): Promise<PluginEnableResult> {
    return this.exclusive('enable', packageName, () => this.enableNow(packageName))
  }

  private async enableNow(packageName: string): Promise<PluginEnableResult> {
    const runtime = this.runtime()
    const installer = this.installer(runtime)
    installer.assertInstalled(packageName)
    try {
      installer.metadata(packageName)
    } catch (error) {
      const reason = `cannot read package declarations: ${messageOf(error)}`
      throw new PluginOperationError('plugins/not-enableable', `${NAME}: ${packageName} ${reason}`, { packageName, reason })
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
      } catch (error) {
        const reason = messageOf(error)
        disableBundle(NAME, runtime.dir, packageName)
        throw new PluginOperationError(
          'plugins/enable-failed',
          `${NAME}: enabling ${packageName} could not apply the layer; its enable selection was reverted: ${reason}`,
          { packageName, reason },
          { cause: error },
        )
      }
    }
    this.changed('enable', packageName)
    return { changed, effect: 'live', ...this.issueResult(await inspectEntryIssues(this.ctx)) }
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
    return { changed, effect: 'live', ...this.issueResult(await inspectEntryIssues(this.ctx)) }
  }

  /**
   * Remove the whole bundle layer, await its cleanup, and enable it again.
   * Every owned row gets a fresh activation attempt.
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
   * Switch one row off or on in a user layer. Deny-only: `true` writes
   * `disabled: true` for the row, `false` removes that key, so a bundle's
   * own `!!js` gate is restored rather than overridden.
   * @param rowId - the row's id as the composition declares it.
   * @param disabled - whether the layer should switch the row off.
   */
  async setRowDisabled(rowId: string, disabled: boolean): Promise<void> {
    return this.exclusive('setRowDisabled', rowId, () => this.setRowDisabledNow(rowId, disabled))
  }

  private async setRowDisabledNow(rowId: string, disabled: boolean): Promise<void> {
    const runtime = this.runtime()
    await this.editLayer(runtime, (document) => {
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
    const owned = ownedEntries(this.ctx, runtime, packageName)
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
    const names = (rows: readonly PatchRow[]): void => {
      for (const row of rows) {
        // A group's config is a row list once the patch parser accepted the file.
        /* v8 ignore next */
        if (row.group === true) names((row.config ?? []) as PatchRow[])
        if (typeof row.id !== 'string') continue
        if (row.name === packageName || row.name.startsWith(`${packageName}/`)) {
          found.push({ rowId: row.id, moduleName: row.name })
        }
      }
    }
    let patches
    try {
      patches = await readPatchListFile(NAME, runtime.patchPath, 'patches')
    } catch {
      // An unreadable layer names nothing this call can act on; the
      // launcher reports it as a composition failure.
      return found
    }
    for (const patch of patches ?? []) if (patch.insert !== undefined) names(patch.insert)
    return found
  }

  /** Edit one user layer file and, for the live global layer, recompose. */
  private async editLayer(
    runtime: ProfileRuntime,
    mutate: Parameters<typeof mutatePatchFile>[1],
  ): Promise<string> {
    const file = runtime.patchPath
    await mutatePatchFile(file, mutate, { binName: NAME, mode: 0o600, dirMode: 0o700 })
    // The profile launcher's watcher reapplies the global file on its own;
    // recomposing here makes the change visible to this call's caller before
    // it returns, and the watcher's later pass composes the same text.
    if (runtime.patchReload === 'live') await runtime.recompose()
    return file
  }

  /** Project runtime objects into the operation's JSON result. */
  private issueResult(issues: readonly EntryIssue[]): { issues?: PluginRowIssue[] } {
    return issues.length === 0 ? {} : { issues: issues.map(issue => ({
      entryId: issue.entry.id, moduleName: issue.entry.options.name, stage: issue.stage, message: issue.message,
    })) }
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
