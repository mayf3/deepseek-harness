import type { Resources, ResourceSnapshot } from '@deepseek-ai/dsh-client-resources/client'
import type { WorkspaceFileStat } from '@deepseek-ai/dsh-api-workspace-files/types'

export class ResourceGroup {
  private readonly members = new Map<string, () => void>()

  constructor(private readonly resources: Resources, private readonly changed: () => void) {}

  add(address: string, version?: string): void {
    if (this.members.has(address)) return
    const source = this.resources.source(address)
    let previous = version === undefined ? undefined : `live:${version}`
    const observe = (): void => {
      const next = source.getSnapshot() as ResourceSnapshot<WorkspaceFileStat>
      if (next.status !== 'live' && next.status !== 'failed') return
      const key = next.status === 'live' ? `live:${next.value?.version}` : `failed:${next.failure?.code}`
      const changed = previous !== undefined && key !== previous
      previous = key
      if (changed) this.changed()
    }
    this.members.set(address, source.subscribe(observe))
    observe()
  }

  set(addresses: readonly string[]): void {
    const retained = new Set(addresses)
    for (const address of retained) this.add(address)
    for (const [address, release] of this.members) {
      if (retained.has(address)) continue
      this.members.delete(address)
      release()
    }
  }

  close(): void {
    this.set([])
  }
}
