/** Identity-stable process permission catalog shared by both selection surfaces. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { PermissionCatalog } from '@deepseek-ai/dsh-permission-presets/client'

/** Observable value and latest read error for the current Host generation. */
export interface PermissionCatalogState {
  /** Last complete catalog for this generation, or null before one succeeds. */
  value: PermissionCatalog | null
  /** Current-generation read failure text, when present. */
  error: string | null
}

/** One latest-result-wins catalog reader for the whole browser process. */
export class PermissionCatalogDirectory {
  /** Complete snapshot consumed by both the slash popup and composer seat. */
  readonly store: SnapshotStore<PermissionCatalogState> = createSnapshotStore({
    value: null,
    error: null,
  })

  private readonly connection: ConnectionHandle
  private readonly stopCatalog: () => void
  private readonly stopGeneration: () => void
  private generationId: number | undefined
  private initialized = false
  private epoch = 0
  private pending: Promise<void> | undefined
  private disposed = false

  /**
   * Subscribe to both invalidation sources before the first read, closing the
   * install/read race.
   * @param ctx - root Client context carrying Remote and Connection.
   */
  constructor(private readonly ctx: ClientContext) {
    this.connection = ctx.get('connection') as ConnectionHandle
    this.stopCatalog = ctx.remote.$on('permission-presets/catalog-changed', () => {
      this.refresh()
    })
    this.stopGeneration = this.connection.generation.subscribe(() => {
      this.syncGeneration()
    })
    this.syncGeneration()
  }

  /** Force a fresh complete read for the active connection generation. */
  refresh(): void {
    if (this.disposed) return
    const generationId = this.connection.generation.getSnapshot()?.id
    if (generationId === undefined) return
    if (generationId !== this.generationId) {
      this.syncGeneration()
      return
    }
    this.startRead(generationId)
  }

  /**
   * Resolve a complete current-generation catalog for an imperative popup
   * open. An active refresh settles before a retained value can be reused.
   * @returns The active Host generation's complete permission catalog.
   */
  async load(): Promise<PermissionCatalog> {
    while (!this.disposed) {
      const generationId = this.connection.generation.getSnapshot()?.id
      if (generationId === undefined) {
        throw new Error('permission catalog has no active Host connection')
      }
      if (generationId !== this.generationId) this.syncGeneration()
      const pending = this.pending
      if (pending !== undefined) {
        await pending
        continue
      }
      const state = this.store.getSnapshot()
      if (state.value !== null) return state.value
      throw new Error(state.error as string)
    }
    throw new Error('permission catalog directory is disposed')
  }

  /** Stop subscriptions and revoke every late settlement's write access. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    ++this.epoch
    this.pending = undefined
    this.stopGeneration()
    this.stopCatalog()
  }

  /** Observe generation loss/replacement and hard-clear the old Host value. */
  private syncGeneration(): void {
    if (this.disposed) return
    const generationId = this.connection.generation.getSnapshot()?.id
    if (this.initialized && generationId === this.generationId) return
    this.initialized = true
    this.generationId = generationId
    ++this.epoch
    this.pending = undefined
    this.store.set({ value: null, error: null })
    if (generationId !== undefined) this.startRead(generationId)
  }

  /** Start one independent read; the newest epoch in the same generation wins. */
  private startRead(generationId: number): void {
    const epoch = ++this.epoch
    const retained = this.store.getSnapshot().value
    this.store.set({ value: retained, error: null })
    const operation = this.ctx.remote.permissionPresets.catalog()
      .then((result) => {
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
        if (!this.accepts(epoch, generationId)) return
        this.store.set({ value: result.value, error: null })
      })
      .catch((error: unknown) => {
        if (!this.accepts(epoch, generationId)) return
        this.store.set({
          value: this.store.getSnapshot().value,
          error: error instanceof Error ? error.message : String(error),
        })
      })
      .finally(() => {
        if (this.pending === operation) this.pending = undefined
      })
    this.pending = operation
  }

  /** Fence by disposal, refresh epoch, and the actual Connection generation. */
  private accepts(epoch: number, generationId: number): boolean {
    return !this.disposed
      && epoch === this.epoch
      && generationId === this.generationId
      && this.connection.generation.getSnapshot()?.id === generationId
  }
}
