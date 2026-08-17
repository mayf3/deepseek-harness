/**
 * Web boot kernel. It owns only the module system, Cordis loader, and a
 * framework-free boot page. The dynamic UI renderer receives the mount
 * point after every client entry activates.
 * @module @deepseek-ai/dsh-client-web/src/boot
 */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type {
  BootManifest, ClientModuleSystem, ClientModuleSystemOptions, DshWindow,
} from '@deepseek-ai/dsh-client-modules/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { BootPage } from './boot-page.ts'
import { getStaticModules } from './seed.ts'
import { STATE_LABELS } from './loader-status.ts'
import './base.css'

/** Module transport hook replaced by jsdom tests. */
export type BootSeams = Pick<ClientModuleSystemOptions, 'loadBundle'>

/** Runtime exports materialized from the parser-preloaded modules bundle. */
type ModulesClientExports = typeof import('@deepseek-ai/dsh-client-modules/client')

/** Statically adopted bootstrap package that constructs the client module system. */
const MODULES_ID = '@deepseek-ai/dsh-client-modules'

/**
 * Claim and materialize the modules handoff before the module system exists.
 * The bootstrap bundle must be self-contained because no module table can
 * answer a runtime external yet.
 * @param win - Browser boot globals populated by the host HTML transform.
 * @returns The modules package's browser exports.
 */
function claimModulesClient(win: DshWindow): ModulesClientExports {
  const queue = win.__ModuleLoader__
  if (queue === undefined || queue.mode !== 'queue') {
    throw new Error('web boot: window.__ModuleLoader__ bootstrap queue is missing')
  }
  const index = queue.handoffs.findIndex(handoff => handoff.id === MODULES_ID)
  const handoff = queue.handoffs[index]
  if (handoff === undefined) {
    throw new Error(`web boot: HTML did not preload ${MODULES_ID}/client.js`)
  }
  queue.handoffs.splice(index, 1)
  const exports = handoff.factory((specifier) => {
    throw new Error(
      `web boot: ${MODULES_ID}/client.js requested external "${specifier}" before the module system existed`,
    )
  })
  if (
    typeof exports.ClientModuleSystem !== 'function'
    || typeof exports.parseBootManifest !== 'function'
    || typeof exports.apply !== 'function'
  ) {
    throw new Error(`web boot: ${MODULES_ID}/client.js did not export the bootstrap module face`)
  }
  return exports as unknown as ModulesClientExports
}

/** Browser boot entry consumed by `apps/web`. */
export class AppWebEntry {
  private readonly container: HTMLElement
  private readonly seams: BootSeams | undefined
  private readonly page: BootPage
  private ctx: Context | undefined
  private modules!: ClientModuleSystem
  private manifest!: BootManifest

  /**
   * Draw the boot page; {@link run} starts the loader.
   * @param container - Application mount point.
   * @param seams - Optional module transport replacement.
   */
  constructor(container: HTMLElement, seams?: BootSeams) {
    this.container = container
    this.seams = seams
    this.page = new BootPage(container)
  }

  /**
   * Load and activate every client entry, then hand the mount point to the
   * UI renderer. Plugin failures remain visible on the boot page.
   * @returns Resolves after application mount or failure rendering.
   */
  async run(): Promise<void> {
    try {
      const win = globalThis as DshWindow
      const modulesClient = claimModulesClient(win)
      this.manifest = modulesClient.parseBootManifest(win.__DSH_BOOT__)
      this.modules = new modulesClient.ClientModuleSystem({
        modules: this.manifest.modules,
        staticModules: getStaticModules(),
        ...this.seams,
      })
      this.modules.registerStatic(MODULES_ID, modulesClient)
      win.__DSH_MODULES__ = this.modules

      const prefetching = this.prefetchImmediateTier()
      const ctx = new Context()
      this.ctx = ctx
      await this.runPluginBoot(ctx, prefetching)
      await this.mountApp(ctx)
    } catch (reason) {
      console.error(reason)
      this.page.fail(reason instanceof Error ? reason.message : String(reason))
    }
  }

  /** Dispose the client plugin tree and whichever page owns the mount point. */
  async dispose(): Promise<void> {
    const ctx = this.ctx
    this.ctx = undefined
    if (ctx !== undefined) await ctx.fiber.dispose()
    this.page.dispose()
  }

  /** Mount through a dependency fiber so replacing uiRenderer remounts the application. */
  private async mountApp(ctx: Context): Promise<void> {
    const mounted = ctx.inject(['uiRenderer'], (scope) => {
      scope.effect(() => scope.uiRenderer.mount(this.container), 'web boot: application mount')
    })
    await mounted
  }

  /** Prefetch stage-one bundles; their import path owns any eventual failure. */
  private async prefetchImmediateTier(): Promise<void> {
    await Promise.all(this.manifest.plugins
      .filter(row => row.immediately)
      .map(row => this.modules.prefetch(row.id).catch((_prefetchError: unknown) => {
        // Prefetch only starts transport early; the Loader import retries and reports this bundle failure.
      })))
  }

  /** Mount the Loader, create all graph entries, await quiescence, and audit activation. */
  private async runPluginBoot(ctx: Context, prefetching: Promise<void>): Promise<void> {
    await ctx.plugin(Loader)
    const loader = ctx.loader
    loader.internal = this.modules as never

    ctx.on('internal/status', (fiber) => {
      const entry = fiber.entry
      if (entry === undefined || entry.fiber === undefined) return
      this.page.setState(entry.options.name, STATE_LABELS[entry.fiber.state])
    })

    const rows = [MODULES_ID, ...this.manifest.plugins.map(row => row.id).filter(id => id !== MODULES_ID)]
    this.page.setTotal(rows.length)
    await prefetching
    await Promise.all(rows.map(async (name) => {
      this.page.setState(name, 'loading')
      const id = await loader.create({ name })
      if (loader.resolve(id).fiber === undefined) this.page.setState(name, 'failed')
    }))

    await loader.await()
    this.assertEntriesActive(ctx)
  }

  /** Reject entries that failed import/apply or still wait on missing services. */
  private assertEntriesActive(ctx: Context): void {
    const failures: string[] = []
    for (const entry of ctx.loader.entries()) {
      const name = entry.options.name
      if (entry.fiber === undefined) {
        failures.push(`${name}: import failed (see console for the import error)`)
        continue
      }
      const state = STATE_LABELS[entry.fiber.state]
      if (state === 'active') continue
      if (state === 'pending') {
        const missing = Object.keys(entry.fiber.inject).filter(service => ctx.get(service) === undefined)
        failures.push(`${name}: pending (waiting for service${missing.length === 1 ? '' : 's'}: ${missing.join(', ') || 'unknown'})`)
      } else {
        failures.push(`${name}: ${state}`)
      }
    }
    if (failures.length > 0) {
      throw new Error(`web boot: ${String(failures.length)} entr${failures.length === 1 ? 'y' : 'ies'} did not activate\n${failures.join('\n')}`)
    }
  }
}
