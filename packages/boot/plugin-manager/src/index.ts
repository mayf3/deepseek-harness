/** Current-profile plugin and bundle management over shared dsh plugin operations. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { Context } from '@deepseek-ai/cordis'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { readPluginInventory } from '@deepseek-ai/dsh-host-plugin-inventory'
import { readProfileManifest, resolveBundleDir, loadOverlayPatches, composeEntries, reconcileProfilePatches, readProfilePatches } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-hmr'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { bundleManifest, runProfilePnpm, saveManifest } from './operations.ts'
import { writePluginEnabled } from './patch.ts'
import type { BundleInfo, ChangeResult, InstallBundleOptions, PackageResult, PluginEntryId, PluginInfo } from './types.ts'
export type * from './types.ts'

/** Limits for package diagnostics and change notifications. */
export interface Config {
  /** Maximum retained pnpm diagnostic bytes per operation. */
  outputBytes?: number
  /** Delay for combining consecutive management notices in one durable injection. */
  notificationDelayMs?: number
  /** Maximum time to wait for another process's profile package operation. */
  lockWaitMs?: number
}

const protectedModules = new Set([
  '@deepseek-ai/dsh-plugin-manager', '@deepseek-ai/cordis-plugin-loader',
  '@deepseek-ai/cordis-plugin-include', '@deepseek-ai/dsh-api-gateway',
  '@deepseek-ai/dsh-host-webserver', '@deepseek-ai/dsh-client-modules',
  '@deepseek-ai/dsh-client-ui-settings-plugin-inventory',
  '@deepseek-ai/cordis-plugin-timer', '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-host-frontend-static', '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-hmr',
])

/** Flatten only the groups addressable by the profile's patch composer. */
function flatten(rows: EntryOptions[]): EntryOptions[] {
  return rows.flatMap(row => [row, ...(row.group && Array.isArray(row.config) ? flatten(row.config as EntryOptions[]) : [])])
}

/** Preserve the exact observed diagnostic, including non-Error failures. */
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error) }

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Persistent management of the current profile's composition and packages. */
    pluginManager: PluginManager
  }
}

/** Manage profile files and apply their declared reload lifecycle. */
export class PluginManager extends TypertRemoteService {
  static inject = ['loader', 'profileContext']
  static Config: z<Config> = z.object({
    outputBytes: z.number().step(1).min(1).default(16384),
    notificationDelayMs: z.number().step(1).min(0).default(250),
    lockWaitMs: z.number().step(1).min(0).default(120000),
  })
  private readonly ownerEntryId: string | undefined
  private readonly packageOperations = new Set<Promise<PackageResult>>()
  private readonly profile: ProfileContext
  private readonly outputBytes: number
  private readonly notificationDelayMs: number
  private readonly lockWaitMs: number
  private readonly ownerContext: Context
  private pendingNotice = ''
  private omittedNotices = 0
  private noticeTimer: ReturnType<typeof setTimeout> | undefined
  private noticeDelivered: PromiseWithResolvers<void> | undefined
  private readonly noticeAgents = new Set<Agent>()
  private readonly abort = new AbortController()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'pluginManager')
    this.ownerEntryId = ctx.fiber.entry?.id
    this.ownerContext = ctx
    this.profile = ctx.profileContext
    this.outputBytes = (config as Required<Config>).outputBytes
    this.notificationDelayMs = (config as Required<Config>).notificationDelayMs
    this.lockWaitMs = (config as Required<Config>).lockWaitMs
    ctx.effect(() => async () => {
      this.abort.abort()
      await Promise.allSettled([...this.packageOperations])
      clearTimeout(this.noticeTimer)
      this.flushNotice()
    }, 'plugin-manager: package cancellation')
  }

  /** Read current plugins, including why a row cannot be changed through the profile patch.
   * @returns Current runtime entries with persistent patch targets.
   */
  @Remote
  async listPlugins(): Promise<PluginInfo[]> {
    const rows = flatten(composeEntries([readProfilePatches('dsh', this.profile)]))
    const snapshot = await readPluginInventory(this.ctx)
    return snapshot.entries.map((entry) => {
      const actual = [...this.ctx.loader.entries()].find(row => row.id === entry.entryId)
      const candidates = rows.filter(row => row.id === actual?.options.id)
      const candidate = candidates[0]
      const readOnlyReason = protectedModules.has(entry.moduleName) || entry.entryId === this.ownerEntryId
        ? 'Required for plugin management.'
        : actual?.parent.tree.ctx.fiber.entry?.id !== 'include'
          || candidates.length !== 1 || candidate?.name !== entry.moduleName
          ? 'This entry is not uniquely addressable by the profile patch.' : undefined
      return { ...entry,
        ...(candidate !== undefined && readOnlyReason === undefined ? { patchId: candidate.id } : {}),
        ...(readOnlyReason === undefined ? {} : { readOnlyReason }),
      }
    })
  }

  /** Read installed bundles and bundles supplied by this dsh installation.
   * @returns Package versions, activation selections and removal availability.
   */
  @Remote
  listBundles(): Promise<BundleInfo[]> {
    const manifest = readProfileManifest('dsh', this.profile.dir)
    const selected = manifest.dsh?.profile?.bundles ?? []
    const dependencies = Object.keys(manifest.dependencies ?? {})
    const installation = JSON.parse(readFileSync(this.profile.installAnchor, 'utf8')) as { dependencies?: Record<string, string> }
    const names = [...new Set([...selected, ...dependencies, ...Object.keys(installation.dependencies ?? {})])]
    const bundles: BundleInfo[] = []
    for (const name of names) {
      const removable = dependencies.includes(name) && !Object.hasOwn(installation.dependencies ?? {}, name)
      try {
        const info = bundleManifest(name, this.profile.dir, this.profile.installAnchor)
        if (info === undefined) {
          if (selected.includes(name)) bundles.push({ name, enabled: true, removable, error: `Not a bundle: ${name}` })
          continue
        }
        const readOnlyReason = this.protectsManager(name) ? 'This bundle provides plugin management components' : undefined
        bundles.push({ name, ...(info.version === undefined ? {} : { version: info.version }),
          enabled: selected.includes(name), removable: removable && readOnlyReason === undefined,
          ...(readOnlyReason === undefined ? {} : { readOnlyReason }) })
      } catch (error) {
        if (selected.includes(name) || dependencies.includes(name)) {
          bundles.push({ name, enabled: selected.includes(name), removable, error: messageOf(error) })
        }
      }
    }
    return Promise.resolve(bundles)
  }

  /** Persist a plugin entry's desired enablement and apply it on live profiles.
   * @param id Loader entry identity returned by listPlugins.
   * @param enabled Whether the plugin should run.
   * @returns Saved and runtime outcomes, including higher-priority overrides.
   */
  @Remote
  setPluginEnabled(id: PluginEntryId, enabled: boolean): Promise<ChangeResult> {
    return this.change(async () => {
      const row = (await this.listPlugins()).find(item => item.entryId === id)
      if (row === undefined) throw new Error(`Unknown plugin entry: ${id}`)
      if (row.readOnlyReason !== undefined || row.patchId === undefined) throw new Error(row.readOnlyReason)
      await writePluginEnabled(this.profile.patchPath, row.patchId, enabled)
      await this.reload()
      const current = (await this.listPlugins()).find(item => item.entryId === id)
      return current?.enabled !== enabled && this.profile.patchReload === 'live' ? 'overridden' : undefined
    }, `Plugin ${id}: ${enabled ? 'enabled' : 'disabled'}.`)
  }

  /** Select or remove a bundle layer while retaining installed dependencies.
   * @param name Bundle package name.
   * @param enabled Whether the bundle contributes its patch layer.
   * @returns Persisted and runtime outcomes.
   */
  @Remote
  setBundleEnabled(name: string, enabled: boolean): Promise<ChangeResult> {
    return this.change(async () => {
      await this.selectBundle(name, enabled)
      await this.reload()
    }, `Bundle ${name}: ${enabled ? 'enabled' : 'disabled'}.`)
  }

  /** Install a package using the same pnpm implementation as dsh plugin.
   * @param spec One package spec, including local paths relative to the invocation directory.
   * @param options Whether to activate the installed bundle; defaults to true.
   * @returns Package-manager diagnostics and observed activation outcome.
   */
  @Remote
  installBundle(spec: string, options?: InstallBundleOptions): Promise<ChangeResult> {
    let packageResult: PackageResult | undefined
    return this.change(async () => {
      if (spec.trim() === '' || spec.startsWith('-')) throw new Error('A package spec is required')
      const before = readProfileManifest('dsh', this.profile.dir).dependencies ?? {}
      packageResult = await this.runPnpm(['add', spec])
      if (packageResult.exitCode !== 0) throw new Error(packageResult.output)
      const after = readProfileManifest('dsh', this.profile.dir).dependencies ?? {}
      const installed = Object.keys(after).filter(name => before[name] !== after[name])
      // Registry retries can retain the saved range after a partial installation.
      if (installed.length === 0) installed.push(...Object.keys(after).filter(name => spec === name || spec.startsWith(`${name}@`)))
      const name = installed[0]
      if (installed.length !== 1 || name === undefined) throw new Error('Cannot identify one installed bundle from the dependency change')
      const dir = resolveBundleDir('dsh', name, this.profile.installAnchor, this.profile.dir)
      const manifest = bundleManifest(name, this.profile.dir, this.profile.installAnchor)
      if (manifest?.dsh?.bundle?.patch === undefined) throw new Error(`${name} declares no dsh.bundle.patch`)
      loadOverlayPatches('dsh', join(dir, manifest.dsh.bundle.patch))
      if (options?.enabled !== false) await this.selectBundle(name, true)
      if (Object.hasOwn(before, name)) return 'restart-required'
      await this.reload()
    }, `Bundle installation: ${spec}.`, () => packageResult)
  }

  /** Unload and remove a profile-owned bundle dependency through dsh plugin's pnpm path.
   * @param name Installed dependency name.
   * @returns Removal diagnostics and the remaining profile state.
   */
  @Remote
  removeBundle(name: string): Promise<ChangeResult> {
    let packageResult: PackageResult | undefined
    return this.change(async () => {
      const bundle = (await this.listBundles()).find(item => item.name === name)
      if (bundle === undefined || !bundle.removable) throw new Error(`Bundle is not a profile-owned dependency: ${name}`)
      if (this.profile.patchReload === 'startup' && this.profile.startedBundles.includes(name)) {
        throw new Error('Stop this startup-only profile and remove the bundle with dsh plugin')
      }
      if (bundle.enabled) {
        await this.selectBundle(name, false)
        await this.reload()
      }
      packageResult = await this.runPnpm(['remove', name])
      if (packageResult.exitCode !== 0) throw new Error(packageResult.output)
      await this.reload()
    }, `Bundle removed: ${name}.`, () => packageResult)
  }

  private async runPnpm(args: readonly string[]): Promise<PackageResult> {
    const task = runProfilePnpm({ ...this.profile, profile: this.profile.name }, args, {
      signal: this.abort.signal, outputBytes: this.outputBytes, activateNewBundles: false,
    })
    this.packageOperations.add(task)
    try { return await task }
    finally { this.packageOperations.delete(task) }
  }

  private async selectBundle(name: string, enabled: boolean): Promise<void> {
    const manifest = readProfileManifest('dsh', this.profile.dir)
    const previous = manifest.dsh?.profile?.bundles ?? []
    if ((enabled || !previous.includes(name)) && bundleManifest(name, this.profile.dir, this.profile.installAnchor) === undefined) {
      throw new Error(`Not a bundle: ${name}`)
    }
    if (!enabled && previous.includes(name)) {
      if (this.protectsManager(name)) throw new Error('This bundle provides plugin management components')
    }
    const bundles = enabled ? [...previous, ...previous.includes(name) ? [] : [name]] : previous.filter(item => item !== name)
    if (JSON.stringify(previous) === JSON.stringify(bundles)) return
    manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } }
    await saveManifest(this.profile.dir, manifest)
  }

  private protectsManager(name: string): boolean {
    const info = bundleManifest(name, this.profile.dir, this.profile.installAnchor)
    if (info?.dsh?.bundle === undefined) return false
    const dir = resolveBundleDir('dsh', name, this.profile.installAnchor, this.profile.dir)
    const rows = flatten(composeEntries([loadOverlayPatches('dsh', join(dir, info.dsh.bundle.patch))]))
    return rows.some(row => protectedModules.has(row.name) || `include:${row.id}` === this.ownerEntryId)
  }

  private async reload(): Promise<void> {
    if (this.profile.patchReload === 'startup') return
    await reconcileProfilePatches(this.ownerContext.root, readProfilePatches('dsh', this.profile), 'dsh')
  }

  private async change(
    operation: () => Promise<ChangeResult['application'] | void>, message: string, packageResult?: () => PackageResult | undefined,
  ): Promise<ChangeResult> {
    let notice: Promise<void> | undefined
    const locked = () => withFileLock(join(this.profile.dir, 'package.json'), async () => {
      this.abort.signal.throwIfAborted()
      const before = this.diskState()
      let application: ChangeResult['application'] = this.profile.patchReload === 'live' ? 'applied' : 'restart-required'
      try {
        application = await operation() ?? application
      } catch (error) {
        application = 'failed'
        message = messageOf(error)
      }
      const result: ChangeResult = { changed: before !== this.diskState(), application, message }
      const packages = packageResult?.()
      if (packages !== undefined) result.packageResult = packages
      notice = this.notify(result)
      return result
    }, { waitMs: this.lockWaitMs })
    const hmr = this.ownerContext.get('hmr')
    const result = await (hmr === undefined ? locked() : hmr.runExclusive(locked))
    await notice
    return result
  }

  private diskState(): string {
    return ['package.json', 'cordis.patch.yml'].map((file) => {
      try { return readFileSync(join(this.profile.dir, file), 'utf8') }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
        throw error
      }
    }).join('\u0000')
  }

  private notify(result: ChangeResult): Promise<void> {
    const agents = this.ownerContext.get('agents')?.list() ?? []
    if (agents.length === 0) return Promise.resolve()
    for (const agent of agents) this.noticeAgents.add(agent)
    this.noticeDelivered ??= Promise.withResolvers<void>()
    const delivered = this.noticeDelivered.promise
    const notice = `Profile ${this.profile.name}: ${result.message} (${result.application})`
    if (Buffer.byteLength(this.pendingNotice + notice) > this.outputBytes) {
      this.omittedNotices += 1
    } else {
      this.pendingNotice += `${notice}\n`
    }
    if (this.noticeTimer !== undefined) return delivered
    this.noticeTimer = setTimeout(() => { this.flushNotice() }, this.notificationDelayMs)
    return delivered
  }

  private flushNotice(): void {
    this.noticeTimer = undefined
    const text = this.pendingNotice + (this.omittedNotices === 0 ? '' : `${this.omittedNotices} additional operations omitted; query plugin_manager for current state.\n`)
    this.pendingNotice = ''
    this.omittedNotices = 0
    const delivered = this.noticeDelivered
    this.noticeDelivered = undefined
    if (delivered === undefined) return
    const agents = [...this.noticeAgents]
    this.noticeAgents.clear()
    for (const agent of agents) {
      try {
        agent.inject(createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: 'plugin-manager' },
        }))
      } catch (error) {
        this.ownerContext.logger.warn('Plugin management notification could not reach an Agent', error)
      }
    }
    delivered.resolve()
  }
}

export default PluginManager
