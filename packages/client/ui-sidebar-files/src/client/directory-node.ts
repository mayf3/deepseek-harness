import type { DirLevel } from './store.ts'

export class DirectoryNode {
  readonly children = new Map<string, DirectoryNode>()
  private readonly controller = new AbortController()
  private readonly signal: AbortSignal
  private task: Promise<void> | undefined
  private reading: Promise<void> | undefined
  private dirty = false
  private initialized = false
  private automatic = true

  constructor(
    readonly path: string,
    private readonly load: (path: string, signal: AbortSignal) => Promise<DirLevel | undefined>,
    private readonly watch: (path: string, signal: AbortSignal) => AsyncIterable<'ready' | 'change'>,
    private readonly failed: (path: string, error: unknown) => void,
    lifetime: AbortSignal,
    private restore: readonly string[] = [],
  ) {
    this.signal = AbortSignal.any([lifetime, this.controller.signal])
  }

  open(): this {
    this.task ??= this.follow()
    return this
  }

  find(path: string): DirectoryNode | undefined {
    if (path === this.path) return this
    for (const child of this.children.values()) {
      const found = child.find(path)
      if (found !== undefined) return found
    }
    return undefined
  }

  expand(path: string, restore: readonly string[] = []): DirectoryNode | undefined {
    if (this.signal.aborted) return undefined
    let child = this.children.get(path)
    if (child === undefined) {
      child = new DirectoryNode(path, this.load, this.watch, this.failed, this.signal, restore)
      child.automatic = this.automatic
      this.children.set(path, child)
    }
    return child.open()
  }

  async collapse(path: string): Promise<void> {
    const child = this.children.get(path)
    this.children.delete(path)
    await child?.close()
  }

  setAutomatic(enabled: boolean): void {
    this.automatic = enabled
    if (enabled && this.dirty) void this.refresh()
    for (const child of this.children.values()) child.setAutomatic(enabled)
  }

  refresh(): Promise<void> {
    this.dirty = true
    this.reading ??= this.read().finally(() => { this.reading = undefined })
    return this.reading
  }

  async refreshTree(): Promise<void> {
    await this.refresh()
    await Promise.all([...this.children.values()].map(child => child.refreshTree()))
  }

  async close(): Promise<void> {
    this.controller.abort()
    await Promise.all([this.task, this.reading, ...[...this.children.values()].map(child => child.close())])
    this.children.clear()
  }

  private async follow(): Promise<void> {
    try {
      for await (const _event of this.watch(this.path, this.signal)) {
        this.dirty = true
        if (!this.initialized || this.automatic) void this.refresh()
      }
    } catch (error) {
      if (!this.signal.aborted) {
        if (!this.initialized) await this.refresh()
        this.failed(this.path, error)
      }
    }
  }

  private async read(): Promise<void> {
    do {
      this.dirty = false
      const level = await this.load(this.path, this.signal)
      if (this.signal.aborted || level === undefined) return
      this.initialized = true
      const directories = new Set(level.entries.filter(entry => entry.type === 'directory')
        .map(entry => `${this.path.replace(/[/\\]+$/, '')}/${entry.name}`))
      for (const path of this.children.keys()) {
        if (!directories.has(path)) await this.collapse(path)
      }
      for (const path of directories) {
        if (this.restore.includes(path)) this.expand(path, this.restore)
      }
      this.restore = []
    } while (this.dirty && this.automatic && !this.signal.aborted)
  }
}
