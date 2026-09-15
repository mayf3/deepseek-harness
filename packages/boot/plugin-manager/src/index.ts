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
import type { BundleInfo, ChangeResult, InstallBundleOptions, ManagementError, PackageResult, PluginEntryId, PluginInfo } from './types.ts'
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
function managementError(error: unknown): ManagementError {
  return error instanceof ManagementFailure ? { code: error.code }
    : { code: 'operation-error', diagnostic: error instanceof Error ? error.message : String(error) }
}

/** Expected management rejection; presentation belongs to the caller's locale. */
class ManagementFailure extends Error {
  readonly code: ManagementError['code']
  constructor(code: ManagementError['code']) { super(code); this.code = code }
}

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
      if (protectedModules.has(entry.moduleName) || entry.entryId === this.ownerEntryId) {
        return { ...entry, readOnlyReason: 'management-required' as const }
      }
      if (candidate === undefined || candidates.length > 1 || candidate.name !== entry.moduleName
        || actual?.parent.tree.ctx.fiber.entry?.id !== 'include') {
        return { ...entry, readOnlyReason: 'unaddressable' as const }
      }
      return { ...entry, patchId: candidate.id }
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
          if (selected.includes(name) || dependencies.includes(name)) {
            bundles.push({ name, enabled: selected.includes(name), removable, error: { code: 'not-bundle' } })
          }
          continue
        }
        const readOnlyReason = this.protectsManager(name) ? 'management-required' as const : undefined
        bundles.push({ name, ...(info.version === undefined ? {} : { version: info.version }),
          enabled: selected.includes(name), removable: removable && readOnlyReason === undefined,
          ...(readOnlyReason === undefined ? {} : { readOnlyReason }) })
      } catch (error) {
        if (selected.includes(name) || dependencies.includes(name)) {
          bundles.push({ name, enabled: selected.includes(name), removable, error: managementError(error) })
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
    return this.change(async (result) => {
      const row = (await this.listPlugins()).find(item => item.entryId === id)
      if (row === undefined) throw new ManagementFailure('unknown-plugin')
      if (row.readOnlyReason !== undefined) throw new ManagementFailure(row.readOnlyReason)
      await writePluginEnabled(this.profile.patchPath, row.patchId, enabled)
      result.warnings = await this.reload(enabled ? [row.patchId] : [])
      const current = (await this.listPlugins()).find(item => item.entryId === id)
      return current?.enabled !== enabled && this.ownerContext.get('hmr') !== undefined ? 'overridden' : undefined
    }, { stage: 'enable', target: id, enabled })
  }

  /** Select or remove a bundle layer while retaining installed dependencies.
   * @param name Bundle package name.
   * @param enabled Whether the bundle contributes its patch layer.
   * @returns Persisted and runtime outcomes.
   */
  @Remote
  setBundleEnabled(name: string, enabled: boolean): Promise<ChangeResult> {
    return this.change(async (result) => {
      await this.selectBundle(name, enabled)
      result.warnings = await this.reload(enabled ? this.bundleRows(name).map(row => row.id) : [])
    }, { stage: 'enable', target: name, enabled })
  }

  /** Install a package using the same pnpm implementation as dsh plugin.
   * @param spec One package spec, including local paths relative to the invocation directory.
   * @param options Whether to activate the installed bundle; defaults to true.
   * @returns Package-manager diagnostics and observed activation outcome.
   */
  @Remote
  installBundle(spec: string, options?: InstallBundleOptions): Promise<ChangeResult> {
    return this.change(async (result) => {
      if (spec.trim() === '' || spec.startsWith('-')) throw new ManagementFailure('invalid-spec')
      const before = readProfileManifest('dsh', this.profile.dir).dependencies ?? {}
      let name: string
      try {
        result.packageResult = await this.runPnpm(['add', spec])
        if (result.packageResult.exitCode !== 0) throw new Error(result.packageResult.output)
        const after = readProfileManifest('dsh', this.profile.dir).dependencies ?? {}
        const installed = Object.keys(after).filter(name => before[name] !== after[name])
        // Registry retries can retain the saved range after a partial installation.
        if (installed.length === 0) installed.push(...Object.keys(after).filter(name => spec === name || spec.startsWith(`${name}@`)))
        const target = installed[0]
        if (installed.length !== 1 || target === undefined) throw new ManagementFailure('ambiguous-install')
        name = target
        const dir = resolveBundleDir('dsh', name, this.profile.installAnchor, this.profile.dir)
        const manifest = bundleManifest(name, this.profile.dir, this.profile.installAnchor)
        if (manifest?.dsh?.bundle?.patch === undefined) throw new ManagementFailure('not-bundle')
        loadOverlayPatches('dsh', join(dir, manifest.dsh.bundle.patch))
      } catch (error) {
        await this.cleanFailedInstall(before, result)
        throw error
      }
      result.target = name
      result.stage = 'enable'
      if (options?.enabled !== false) await this.selectBundle(name, true)
      if (Object.hasOwn(before, name)) return 'restart-required'
      result.warnings = await this.reload()
    }, { stage: 'install', target: spec, enabled: options?.enabled !== false })
  }

  private async cleanFailedInstall(before: Record<string, string>, result: ChangeResult): Promise<void> {
    try {
      const manifest = readProfileManifest('dsh', this.profile.dir)
      const added = Object.keys(manifest.dependencies ?? {}).filter(name => !Object.hasOwn(before, name))
      result.remainingDependencies = added
      const name = added[0]
      const installation = JSON.parse(readFileSync(this.profile.installAnchor, 'utf8')) as { dependencies?: Record<string, string> }
      if (added.length !== 1 || name === undefined || manifest.dsh?.profile?.bundles?.includes(name)
        || Object.hasOwn(installation.dependencies ?? {}, name)) return
      result.cleanup = { name }
      result.cleanup.packageResult = await this.runPnpm(['remove', name])
      if (result.cleanup.packageResult.exitCode !== 0) {
        result.cleanup.error = { code: 'operation-error', diagnostic: result.cleanup.packageResult.output }
      }
      result.remainingDependencies = Object.keys(readProfileManifest('dsh', this.profile.dir).dependencies ?? {})
        .filter(name => !Object.hasOwn(before, name))
    } catch (error) {
      if (result.cleanup !== undefined) result.cleanup.error = managementError(error)
      else result.warnings = [String(error)]
    }
  }

  /** Unload and remove a profile-owned bundle dependency through dsh plugin's pnpm path.
   * @param name Installed dependency name.
   * @returns Removal diagnostics and the remaining profile state.
   */
  @Remote
  removeBundle(name: string): Promise<ChangeResult> {
    return this.change(async (result) => {
      const bundle = (await this.listBundles()).find(item => item.name === name)
      if (bundle === undefined || !bundle.removable) throw new ManagementFailure('not-removable')
      if (this.ownerContext.get('hmr') === undefined && (this.profile.startedBundles.includes(name)
        || this.bundleRows(name).some(row => [...this.ctx.loader.entries()]
          .some(entry => entry.options.id === row.id && entry.fiber !== undefined)))) {
        throw new ManagementFailure('stop-profile')
      }
      const contributions = bundle.error === undefined ? this.bundleRows(name) : []
      if (bundle.enabled) {
        await this.selectBundle(name, false)
        result.warnings = await this.reload()
      }
      if ([...this.ctx.loader.entries()].some(entry => entry.fiber?.uid != null
        && contributions.some(row => row.id === entry.options.id && row.name === entry.options.name))) {
        throw new ManagementFailure('bundle-in-use')
      }
      result.packageResult = await this.runPnpm(['remove', name])
      if (result.packageResult.exitCode !== 0) throw new Error(result.packageResult.output)
      result.warnings = await this.reload()
    }, { stage: 'remove', target: name })
  }

  private async runPnpm(args: readonly string[]): Promise<PackageResult> {
    const task = runProfilePnpm({ ...this.profile, profile: this.profile.name }, args, {
      execution: 'service', signal: this.abort.signal, outputBytes: this.outputBytes, activateNewBundles: false,
    })
    this.packageOperations.add(task)
    try { return await task }
    finally { this.packageOperations.delete(task) }
  }

  private async selectBundle(name: string, enabled: boolean): Promise<void> {
    const manifest = readProfileManifest('dsh', this.profile.dir)
    const previous = manifest.dsh?.profile?.bundles ?? []
    if ((enabled || !previous.includes(name)) && bundleManifest(name, this.profile.dir, this.profile.installAnchor) === undefined) {
      throw new ManagementFailure('not-bundle')
    }
    if (!enabled && previous.includes(name)) {
      if (this.protectsManager(name)) throw new ManagementFailure('management-required')
    }
    const bundles = enabled ? [...previous, ...previous.includes(name) ? [] : [name]] : previous.filter(item => item !== name)
    if (JSON.stringify(previous) === JSON.stringify(bundles)) return
    manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } }
    await saveManifest(this.profile.dir, manifest)
  }

  private bundleRows(name: string): EntryOptions[] {
    const info = bundleManifest(name, this.profile.dir, this.profile.installAnchor)
    if (info?.dsh?.bundle === undefined) return []
    const dir = resolveBundleDir('dsh', name, this.profile.installAnchor, this.profile.dir)
    return flatten(composeEntries([loadOverlayPatches('dsh', join(dir, info.dsh.bundle.patch))]))
  }

  private protectsManager(name: string): boolean {
    return this.bundleRows(name).some(row => protectedModules.has(row.name) || `include:${row.id}` === this.ownerEntryId)
  }

  private async reload(requiredIds: readonly string[] = []): Promise<string[]> {
    if (this.ownerContext.get('hmr') === undefined) return []
    return reconcileProfilePatches(this.ownerContext.root, readProfilePatches('dsh', this.profile), 'dsh', requiredIds)
  }

  private async change(
    operation: (result: ChangeResult) => Promise<ChangeResult['application'] | void>,
    request: Pick<ChangeResult, 'stage' | 'target' | 'enabled'>,
  ): Promise<ChangeResult> {
    let notice: Promise<void> | undefined
    const locked = () => withFileLock(join(this.profile.dir, 'package.json'), async () => {
      this.abort.signal.throwIfAborted()
      const before = this.diskState()
      const result: ChangeResult = { ...request, changed: false,
        application: this.ownerContext.get('hmr') !== undefined ? 'applied' : 'restart-required' }
      try {
        result.application = await operation(result) ?? result.application
      } catch (error) {
        result.application = 'failed'
        result.error = managementError(error)
      }
      result.changed = before !== this.diskState()
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
    const notice = JSON.stringify({ profile: this.profile.name, ...result })
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
    const text = this.pendingNotice + (this.omittedNotices === 0 ? '' : JSON.stringify({ omitted: this.omittedNotices, refresh: 'plugin_manager' }) + '\n')
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
