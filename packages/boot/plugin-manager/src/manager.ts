/**
 * Plugin management over the booted profile: every operation the `plugins`
 * Remote exposes, one mutation at a time, with the tree read through the
 * Cordis context and the profile runtime, the preset roster, and the
 * running-agent count read through per-call readers.
 * @module @deepseek-ai/dsh-plugin-manager/manager
 */

import type { Context, Fiber } from '@deepseek-ai/cordis'
import {
  disableBundle,
  enableBundle,
  healProfilesModuleFallback,
  loadProfile,
  readProfileManifest,
  recordContainedStates,
  type probePackage,
  type ProfileRuntime,
} from '@deepseek-ai/dsh-app-boot'
import { mutatePatchFile, readPatchListFile, type PatchRow } from '@deepseek-ai/dsh-app-boot/patch-file'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { PluginOperationError } from './errors.ts'
import { bundlesOf, dependenciesOf, messageOf, NAME, optional, type PluginToolingConfig, type SpawnLike } from './helpers.ts'
import { PluginInstaller } from './installer.ts'
import { derivedRowId, moduleSpecifier } from './modules.ts'
import type {
  PluginChangeReason,
  PluginDependents,
  PluginEnableResult,
  PluginInstallResult,
  PluginPackageView,
  PluginRowAddition,
  PluginRowReference,
  PluginRowTarget,
  PluginServiceDependent,
} from './types.ts'
import { ownedEntries, packageView } from './view.ts'

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
      // The chunks feed the Web install dialog's terminal, which draws SGR colour.
      color: true,
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
    for (const name of names) views.push(await packageView(this.ctx, runtime, installer, manifest, name))
    return views
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
