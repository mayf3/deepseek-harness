/** Metadata inventory of saved and adopted layouts without mounting their content. */
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TabId, TabRecord } from '@deepseek-ai/dsh-client-ui-dockkit'

/** One open occurrence; resource recovery belongs to its kind's provider. */
export interface SidebarRightOpenTab {
  readonly sessionId: SessionId
  readonly tabId: TabId
  readonly kind: string
  readonly contentId: string
}

/** Persistence namespace shared by scoped stores and startup discovery. */
export const sidebarPersistence = 'dsh.sidebar-right.v1'

/** Derived membership only; layout stores remain the persisted authority. */
export class OpenSidebarTabs {
  private readonly sessions = new Map<SessionId, readonly SidebarRightOpenTab[]>()
  private readonly snapshot = createSnapshotStore<readonly SidebarRightOpenTab[]>([])
  /** Read-only metadata observable shared with content providers. */
  readonly source: ObservableSnapshot<readonly SidebarRightOpenTab[]> = this.snapshot

  /** Read saved layouts once before the root service is published. */
  constructor() {
    try {
      if (typeof localStorage === 'undefined') return
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index)
        if (key === null || !key.startsWith(`${sidebarPersistence}.`)) continue
        const sessionId = key.slice(sidebarPersistence.length + 1) as SessionId
        try {
          const saved: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
          const surface = record(record(record(saved)?.bySession)?.[sessionId])
          const tabs = record(record(surface?.layout)?.tabs)
          if (tabs === undefined) continue
          const rows: SidebarRightOpenTab[] = []
          for (const [tabId, value] of Object.entries(tabs)) {
            const tab = record(value)
            if (tab?.id !== tabId || typeof tab.kind !== 'string' || typeof tab.contentId !== 'string') continue
            rows.push({ sessionId, tabId: tabId as TabId, kind: tab.kind, contentId: tab.contentId })
          }
          this.sessions.set(sessionId, rows)
        } catch (_invalidSavedLayout) { /* Other Sessions remain independently recoverable. */ }
      }
      this.publish()
    } catch (_storageUnavailable) { /* Adopted in-memory layouts still publish their open tabs. */ }
  }

  /**
   * Replace membership from the authoritative in-window store.
   * @param sessionId - adopted Session.
   * @param tabs - current committed records.
   */
  update(sessionId: SessionId, tabs: readonly TabRecord[]): void {
    this.sessions.set(sessionId, tabs.map(tab => ({ sessionId, tabId: tab.id, kind: tab.kind, contentId: tab.contentId })))
    this.publish()
  }

  /**
   * Forget a permanently cleared scope.
   * @param sessionId - removed Session scope.
   */
  remove(sessionId: SessionId): void { this.sessions.delete(sessionId); this.publish() }

  private publish(): void {
    const next = [...this.sessions.values()].flat()
    if (JSON.stringify(next) !== JSON.stringify(this.snapshot.getSnapshot())) this.snapshot.set(next)
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
