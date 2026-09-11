/**
 * The `pluginManager` service and the `plugins` Remote of the Web host: a
 * Typert service that relays each call to the shared plugin manager over the
 * booted profile and maps its `plugins/*` failures onto Remote errors of the
 * same code. What plugin management does lives in `dsh-plugin-manager`; this
 * row only reads the profile runtime, the preset roster, and the agent
 * registry off the context and hands them over.
 * @module @deepseek-ai/dsh-host-plugin-manager
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { readPackageMetadata } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import {
  PluginManager,
  pluginOperationFailureOf,
  type PluginDependents,
  type PluginEnableResult,
  type PluginInstallResult,
  type PluginOperationFailure,
  type PluginPackageView,
  type PluginRowAddition,
  type PluginRowTarget,
  type SpawnLike,
} from '@deepseek-ai/dsh-plugin-manager'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { assertNever, type JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Plugin management over the booted profile; mounted by the web bundle. */
    pluginManager: PluginManagerRemote
  }
}

/** Plugin config: the pnpm command and the bounds on the child processes plugin management runs. */
export interface Config {
  /** The pnpm executable name or path; resolved through `PATH` like the `dsh plugin` command. */
  pnpmCommand: string
  /** Bound on one install or remove run, in milliseconds. */
  installTimeoutMs: number
  /** How many trailing bytes of an install run's output an install failure reports. */
  installLogTailBytes: number
}

/** Test seams: the child spawner, the static metadata reader, or a manager standing in for the shared one. */
export interface PluginManagerInternals {
  spawn?: SpawnLike
  metadata?: typeof readPackageMetadata
  /** The manager every call relays to; defaults to one over this context's profile runtime. */
  manager?: PluginManager
}

/**
 * The `pluginManager` service and the `plugins` Remote.
 *
 * The row injects only the Loader; the profile runtime, the preset roster,
 * and the agent registry are read off the context per call, so a
 * composition without them (a test, a launcher other than the profile
 * launcher) still mounts this service and every call then reports
 * `plugins/unavailable` rather than the service failing to start.
 */
export class PluginManagerRemote extends TypertRemoteService {
  static inject = ['loader']

  static Config: z<Config> = z.object({
    pnpmCommand: z.string().default('pnpm'),
    installTimeoutMs: z.number().min(1_000).default(600_000),
    installLogTailBytes: z.number().min(256).default(16_384),
  })

  private readonly manager: PluginManager

  constructor(ctx: Context, public config: Config, internals: PluginManagerInternals = {}) {
    super(ctx, 'pluginManager', { namespace: 'plugins' })
    this.manager = internals.manager ?? new PluginManager(ctx, {
      config,
      runtime: () => ctx.get('profileRuntime'),
      presets: () => ctx.get('agentPresets'),
      runningAgents: () => (ctx.get('agents')?.list() ?? []).filter(agent => agent.status === 'running').length,
      ...internals.spawn === undefined ? {} : { spawn: internals.spawn },
      ...internals.metadata === undefined ? {} : { metadata: internals.metadata },
    })
    const loader = ctx.loader
    let generation = 0
    let disposed = false
    ctx.effect(() => () => { disposed = true })
    const refresh = (): void => {
      const requested = ++generation
      // Loader events precede asynchronous import/update completion; publish only after settlement.
      void Promise.resolve().then(async () => {
        await loader.await()
        await ctx.get('profileRuntime')?.whenIdle()
        if (!disposed && requested === generation) ctx.emit('plugins/changed', { reason: 'runtime' })
      }).catch((error: unknown) => { ctx.logger.warn('plugin inventory refresh failed', error) })
    }
    ctx.on('internal/status', (fiber) => { if (fiber.entry !== undefined) refresh() }, { global: true })
    ctx.on('loader/entry-init', refresh, { global: true })
    ctx.on('loader/partial-dispose', refresh, { global: true })

  }

  /**
   * Every package the profile knows, one view each.
   * @returns the views, bundles first in layer order.
   */
  @Remote('list')
  async list(): Promise<PluginPackageView[]> {
    return relay(() => this.manager.list())
  }

  /**
   * Install a package with pnpm, read its declarations, and leave it disabled unless asked otherwise.
   * @param spec - what to install, in pnpm's own vocabulary.
   * @param options - `enable` puts every newly installed bundle into the layer list at once.
   * @returns what the run installed and enabled.
   */
  @Remote('add')
  async add(spec: string, options?: { enable?: boolean }): Promise<PluginInstallResult> {
    return relay(() => this.manager.add(spec, options))
  }

  /**
   * Remove a package from the profile with its user-layer rows and any obsolete discovery cache.
   * @param packageName - the installed dependency to remove.
   */
  @Remote('uninstall')
  async uninstall(packageName: string): Promise<void> {
    return relay(() => this.manager.uninstall(packageName))
  }

  /**
   * Put an installed bundle into the layer list and, on a live profile, recompose the tree with it.
   * @param packageName - the installed bundle.
   * @returns whether the list changed and whether the change is live.
   */
  @Remote('enable')
  async enable(packageName: string): Promise<PluginEnableResult> {
    return relay(() => this.manager.enable(packageName))
  }

  /**
   * Take a bundle out of the layer list and, on a live profile, recompose the tree without it.
   * @param packageName - the enabled bundle.
   * @returns whether the list changed and whether the change is live.
   */
  @Remote('disable')
  async disable(packageName: string): Promise<PluginEnableResult> {
    return relay(() => this.manager.disable(packageName))
  }

  /**
   * Compose an enabled bundle again from scratch.
   * @param packageName - the enabled bundle.
   * @returns the enable outcome of the second step.
   */
  @Remote('retry')
  async retry(packageName: string): Promise<PluginEnableResult> {
    return relay(() => this.manager.retry(packageName))
  }

  /**
   * Add a row naming one of the package's modules to a user layer.
   * @param packageName - the installed package.
   * @param target - which layer.
   * @param options - `module` selects a declared `dsh.plugins[]` name (default `.`),
   * `id` overrides the derived row id, `config` overrides the declared default.
   * @returns where the row landed.
   */
  @Remote('addRow')
  async addRow(
    packageName: string,
    target: PluginRowTarget,
    options?: { module?: string; id?: string; config?: JsonValue },
  ): Promise<PluginRowAddition> {
    return relay(() => this.manager.addRow(packageName, target, options))
  }

  /**
   * Remove a row a user layer inserted.
   * @param target - which layer.
   * @param rowId - the inserted row's id.
   */
  @Remote('removeRow')
  async removeRow(target: PluginRowTarget, rowId: string): Promise<void> {
    return relay(() => this.manager.removeRow(target, rowId))
  }

  /**
   * Switch one row off or on in a user layer; deny-only.
   * @param target - which layer.
   * @param rowId - the row's id as the composition declares it.
   * @param disabled - whether the layer should switch the row off.
   */
  @Remote('setRowDisabled')
  async setRowDisabled(target: PluginRowTarget, rowId: string, disabled: boolean): Promise<void> {
    return relay(() => this.manager.setRowDisabled(target, rowId, disabled))
  }

  /**
   * What disabling or removing a package would strand.
   * @param packageName - the package.
   * @returns the dependents.
   */
  @Remote('dependents')
  async dependents(packageName: string): Promise<PluginDependents> {
    return relay(() => this.manager.dependents(packageName))
  }
}

/**
 * Run one manager call and turn its failure into the Remote error of the
 * same code; anything else propagates untouched.
 */
async function relay<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    const failure = pluginOperationFailureOf(error)
    throw failure === undefined ? error : remoteErrorOf(failure)
  }
}

/**
 * The Remote error a plugin operation failure crosses the wire as: the same
 * code and details, except the generic refusal, which is the Gateway's
 * `gateway/bad-request`.
 * @param failure - the manager's failure.
 * @returns the Remote error, with the failure as its cause.
 */
export function remoteErrorOf(failure: PluginOperationFailure): RemoteError {
  const options = { cause: failure }
  switch (failure.code) {
    case 'plugins/unavailable': return new RemoteError(failure.code, failure.message, failure.details, options)
    case 'plugins/not-installed': return new RemoteError(failure.code, failure.message, failure.details, options)
    case 'plugins/not-enableable': return new RemoteError(failure.code, failure.message, failure.details, options)
    case 'plugins/enable-failed': return new RemoteError(failure.code, failure.message, failure.details, options)
    case 'plugins/install-failed': return new RemoteError(failure.code, failure.message, failure.details, options)
    case 'plugins/row-conflict': return new RemoteError(failure.code, failure.message, failure.details, options)
    case 'plugins/busy': return new RemoteError(failure.code, failure.message, failure.details, options)
    case 'plugins/agents-running': return new RemoteError(failure.code, failure.message, failure.details, options)
    case 'plugins/bad-request': return new RemoteError('gateway/bad-request', failure.message, {}, options)
    /* v8 ignore next -- closed-union exhaustiveness guard */
    default: return assertNever(failure)
  }
}

export default PluginManagerRemote
