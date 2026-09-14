/** Page-owned Loader entries; transport-independent reconciliation, retries and code replacement. */
import type { FiberState } from '@deepseek-ai/cordis'
import type { Entry, Loader } from '@deepseek-ai/cordis-plugin-loader'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { parseBootManifest } from './manifest.ts'
import type { BootManifest, ClientModuleLoader } from './manifest.ts'
import { removeOwnedStyles, tearDownEntryFiber } from './entry-lifecycle.ts'

/** Page-local failures do not change the Host's bundle enablement. */
export interface ClientEntryState {
  /** True while a snapshot, retry or code replacement is being applied. */
  readonly syncing: boolean
  /** Package ids and errors from the latest reconciliation. */
  readonly failures: readonly { readonly id: string; readonly message: string }[]
}

/** Internal capabilities owned by the module table, called only after serialized entry operations. */
interface ModuleIndex {
  update(manifest: BootManifest): void
  prune(roots: Iterable<string>): void
}

/** Numeric values mirror Cordis's const enum, which bundle loaders cannot import as a runtime object. */
const ACTIVE = 2 as FiberState.ACTIVE
const FAILED = 3 as FiberState.FAILED

/** Manages only entries created from the Host manifest; other Loader contributors retain ownership. */
export class ClientEntries {
  /** Stable observable consumed by page diagnostics through the renderer's injected hook. */
  readonly state: ObservableSnapshot<ClientEntryState> = {
    getSnapshot: () => this.snapshot,
    subscribe: (listener) => {
      this.listeners.add(listener)
      return () => { this.listeners.delete(listener) }
    },
  }
  // The modules bootstrap factory cannot request platform libraries before the shell supplies its seed.
  private snapshot: ClientEntryState = { syncing: false, failures: [] }
  private readonly listeners = new Set<() => void>()
  private readonly managed = new Map<string, Entry>()
  private readonly revisions = new Map<string, string>()
  private loader: Loader | undefined
  private queue: Promise<void> = Promise.resolve()
  private desired: BootManifest
  private generation = 0
  private stopped = false

  /**
   * Construct the page controller before Cordis boot.
   * @param modules - Module arrival and materialization owner.
   * @param index - Private descriptor replacement and unused-module cleanup.
   */
  constructor(private readonly modules: ClientModuleLoader, private readonly index: ModuleIndex) {
    this.desired = modules.manifest
  }

  /**
   * Create the initial roster and retain its entry identities for subsequent reconciliation.
   * @param loader - Page Loader, already configured with the module system.
   * @param manifest - Initial roster audited by the boot caller.
   * @returns after initial entries and their activation settle; boot owns its activation audit.
   */
  start(loader: Loader, manifest: BootManifest): Promise<void> {
    if (this.loader !== undefined) throw new Error('client-modules: entries already started')
    this.loader = loader
    this.desired = manifest
    loader.ctx.effect(() => () => {
      this.stopped = true
      this.generation++
      return this.queue
    }, 'client-modules: entry reconciliation')
    return this.enqueue(async () => {
      await Promise.all(this.desired.plugins.map(async ({ id }) => {
        await this.create(loader, id)
      }))
      await loader.await()
      for (const row of this.modules.manifest.modules) this.revisions.set(row.id, row.rev)
    })
  }

  /**
   * Validate and apply the latest full Host graph. A later snapshot prevents an older download from mounting.
   * @param graph - JSON-decoded graph received from the Host.
   * @returns after the queued reconciliation; per-package failures remain available in {@link state}.
   */
  sync(graph: unknown): Promise<void> {
    this.desired = parseBootManifest(graph)
    const generation = ++this.generation
    return this.enqueue(() => this.reconcile(generation))
  }

  /**
   * Retry failed entries against the latest graph, including an unchanged revision.
   * @returns after retry settlement, with remaining errors in {@link state}.
   */
  retry(): Promise<void> {
    const generation = ++this.generation
    return this.enqueue(() => this.reconcile(generation))
  }

  /**
   * Replace one entry's code in the same queue as graph updates; duplicate revisions are ignored.
   * @param id - Package id from a rebuilt frame.
   * @param rev - Opaque revision selecting the rebuilt artifact.
   * @returns after replacement settles; failure rejects and is exposed in page diagnostics.
   */
  reload(id: string, rev: string): Promise<void> {
    this.desired = {
      ...this.desired,
      modules: this.desired.modules.map(row => row.id === id ? { ...row, rev } : row),
    }
    return this.enqueue(async () => {
      if (this.stopped || !this.desired.modules.some(row => row.id === id)) return
      const entry = this.managed.get(id)
      if (entry === undefined || this.revisions.get(id) === rev) return
      this.publish({ syncing: true, failures: this.snapshot.failures.filter(failure => failure.id !== id) })
      await this.replace(entry, id, rev, this.generation)
      this.publish({ syncing: false, failures: this.snapshot.failures })
    }, id)
  }

  private publish(snapshot: ClientEntryState): void {
    this.snapshot = snapshot
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (error) {
        console.error('client-modules: synchronization subscriber failed', error)
      }
    }
  }

  private enqueue(task: () => Promise<void>, subject = 'graph'): Promise<void> {
    const run = this.queue.then(task)
    // Each operation reports its own failure; later operations must still run.
    this.queue = run.then(() => undefined, (error: unknown) => {
      this.publish({ syncing: false, failures: [
        ...this.snapshot.failures.filter(failure => failure.id !== subject),
        { id: subject, message: String(error) },
      ] })
    })
    return run
  }

  private current(generation: number): boolean {
    return !this.stopped && generation === this.generation
  }

  /** Keep ownership even when Loader rejects a module's plugin exports after inserting its entry. */
  private async create(loader: Loader, id: string): Promise<void> {
    const options = { name: id }
    const entryId = loader.ensureId(options)
    try {
      await loader.create(options)
    } finally {
      this.managed.set(id, loader.resolve(entryId))
    }
  }

  private async replace(entry: Entry, id: string, rev: string, generation: number): Promise<void> {
    this.modules.invalidate(id, rev)
    await this.modules.prefetch(id)
    if (!this.current(generation)) return
    await tearDownEntryFiber(entry)
    removeOwnedStyles(id)
    if (!this.current(generation)) return
    await this.modules.import(id, '', {})
    if (!this.current(generation)) return
    await entry.refresh()
    await entry.fiber?.await()
    if (entry.fiber === undefined) throw new Error(`client-modules: ${id} import failed (see console)`)
    this.revisions.set(id, rev)
  }

  private async reconcile(generation: number): Promise<void> {
    if (!this.current(generation)) return
    const loader = this.loader
    if (loader === undefined) throw new Error('client-modules: entries have not started')
    const manifest = this.desired
    this.publish({ syncing: true, failures: [] })
    const failures: { id: string; message: string }[] = []
    this.index.update(manifest)
    const wanted = new Set(manifest.plugins.map(row => row.id))
    for (const [id, entry] of this.managed) {
      if (wanted.has(id)) continue
      const fiber = entry.fiber
      loader.remove(entry.id)
      this.managed.delete(id)
      this.revisions.delete(id)
      // Removed fibers no longer appear in Loader.getTasks().
      while (fiber?.inertia !== undefined) await fiber.inertia
    }
    for (const row of manifest.modules) {
      if (!this.current(generation)) break
      try {
        const entry = this.managed.get(row.id)
        if (entry === undefined) {
          await this.modules.prefetch(row.id)
          if (!this.current(generation)) break
          await this.modules.import(row.id, '', {})
          if (!this.current(generation)) break
          await this.create(loader, row.id)
          this.revisions.set(row.id, row.rev)
        } else if (this.revisions.get(row.id) !== row.rev) {
          await this.replace(entry, row.id, row.rev, generation)
        } else if (entry.fiber === undefined) {
          await this.replace(entry, row.id, row.rev, generation)
        } else if (entry.fiber.state === FAILED) {
          entry.fiber.update(entry.options.config)
        }
      } catch (error) {
        failures.push({ id: row.id, message: String(error) })
      }
    }
    await loader.await()
    for (const [id, entry] of this.managed) {
      if (failures.some(failure => failure.id === id)) continue
      if (entry.fiber?.state === ACTIVE) continue
      try {
        if (entry.fiber === undefined) throw new Error(`client-modules: ${id} import failed (see console)`)
        await entry.fiber.await()
        failures.push({ id, message: `client-modules: ${id} is waiting for activation` })
      } catch (error) {
        failures.push({ id, message: String(error) })
      }
    }
    this.index.prune([...loader.entries()].map(entry => entry.options.name))
    if (this.current(generation)) this.publish({ syncing: false, failures })
  }
}
