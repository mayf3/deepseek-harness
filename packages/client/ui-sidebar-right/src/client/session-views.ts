/** Selection and retention policy for independently owned Sidebar Session views. */
import type { ISessions, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SidebarSessionView } from './session-view.ts'

/** The reference is exclusively a framework SessionProvider target, not a business-component service. */
export interface SidebarSessionViewSnapshot {
  readonly sessionId: SessionId
  readonly reference: SessionReference
  readonly selected: boolean
}

/** Selects and retires views; the Sidebar plugin's injected dependencies own global teardown. */
export class SidebarSessionViews {
  readonly source = createSnapshotStore<readonly SidebarSessionViewSnapshot[]>([])
  private readonly views = new Map<SessionId, SidebarSessionView>()
  private readonly viewsByReference = new Map<SessionReference, SidebarSessionView>()
  private selected: SessionId | undefined
  private closed = false

  constructor(private readonly sessions: ISessions) {}

  /** @param sessionId - main selection, or absence; existing retained background views stay bound. */
  select(sessionId: SessionId | undefined): void {
    if (this.closed || this.selected === sessionId) return
    this.selected = sessionId
    if (sessionId !== undefined && !this.views.has(sessionId)) {
      const view = new SidebarSessionView(sessionId, this.sessions, disposed => {
        this.viewsByReference.delete(disposed.reference)
      })
      this.views.set(sessionId, view)
      this.viewsByReference.set(view.reference, view)
    }
    for (const view of this.views.values()) this.prune(view)
    this.publish()
  }

  /**
   * Bind a committed root; release retired references after that root unmounts.
   * @param reference - framework target published by this owner.
   * @returns releases this committed mount.
   */
  mount(reference: SessionReference): () => void {
    const view = this.viewsByReference.get(reference)
    if (view === undefined) {
      if (this.closed) return () => {}
      throw new Error('Sidebar Session view reference is no longer owned')
    }
    return view.mount()
  }

  /**
   * Hold an initialized tab occurrence until unmount or occurrence cancellation.
   * @param sessionId - mounted Session identity.
   * @param tabId - initialized body identity.
   * @param signal - occurrence lifetime; closing and undoing a tab creates a new lifetime.
   * @returns idempotent release of this body's hold.
   */
  retainTab(sessionId: SessionId, tabId: TabId, signal: AbortSignal): () => void {
    if (signal.aborted || this.closed) return () => {}
    const view = this.views.get(sessionId)
    if (view === undefined) throw new Error(`Sidebar Session "${sessionId}" has no mounted view`)
    return view.retainTab(tabId, signal, () => { this.prune(view) })
  }

  /** Plugin shutdown releases every view, including any awaiting a React unmount. */
  dispose(): void {
    this.closed = true
    this.views.clear()
    this.source.set([])
    for (const view of this.viewsByReference.values()) view.dispose()
  }

  private prune(view: SidebarSessionView): void {
    if (view.sessionId === this.selected || view.hasRetainedTabs || this.views.get(view.sessionId) !== view) return
    this.views.delete(view.sessionId)
    // Render targets must be withdrawn before an unmounted view can release its reference.
    this.publish()
    view.retire()
  }

  private publish(): void {
    if (this.closed) return
    this.source.set([...this.views.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId)).map(view => ({
      sessionId: view.sessionId, reference: view.reference, selected: view.sessionId === this.selected,
    })))
  }
}
