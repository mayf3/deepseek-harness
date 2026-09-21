/** Live DOM ownership for docked and floating sidebar pages. */
import type { LayoutState, PaneId, TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TabOccurrence } from './tab-domain.ts'

/** A page captured from the currently mounted Session and its current occurrence. */
export interface SidebarRightTarget {
  readonly sessionId: SessionId
  readonly paneId: PaneId
  readonly host: 'dock' | 'float'
  readonly tabId: TabId | undefined
  readonly occurrence: TabOccurrence | undefined
  readonly navigationRevision: number | undefined
}

/**
 * Read pane and tab identity from live owner markup, including an embedding iframe.
 * @param element - focused or pointer-activated element in the product document.
 * @param sessionId - Session currently drawn by the sidebar.
 * @param layout - current committed layout for that Session.
 * @param occurrence - current occurrence lookup for a committed tab.
 * @returns the captured page, or undefined for stale, hidden, or outside elements.
 */
export function sidebarTargetFromElement(
  element: Element | null,
  sessionId: SessionId,
  layout: LayoutState,
  occurrence: (tabId: TabId) => TabOccurrence,
): SidebarRightTarget | undefined {
  if (element === null || !element.isConnected) return undefined
  const owner = element.closest<HTMLElement>('[data-sidebar-right-session]')
  if (owner?.dataset.sidebarRightSession !== sessionId) return undefined
  const container = element.closest<HTMLElement>('[data-dockkit-pane], [data-dockkit-float]')
  const paneId = (container?.dataset.dockkitPane ?? container?.dataset.dockkitFloat) as PaneId | undefined
  if (paneId === undefined) return undefined
  const pane = layout.nodes[paneId]
  if (pane?.kind !== 'pane' || (pane.host === 'dock' && !layout.expanded)) return undefined
  const tabElement = element.closest<HTMLElement>('[data-dockkit-tab], [data-sidebar-right-tab]')
  const tabId = (tabElement?.dataset.dockkitTab ?? tabElement?.dataset.sidebarRightTab ?? pane.activeTabId) as TabId | undefined
  if (tabId !== undefined && (!pane.tabs.includes(tabId) || layout.tabs[tabId] === undefined)) return undefined
  const held = tabId === undefined ? undefined : occurrence(tabId)
  const marker = element.closest<HTMLElement>('[data-sidebar-right-occurrence]')
    ?? tabElement?.querySelector<HTMLElement>('[data-sidebar-right-occurrence]')
  if (marker !== null && marker !== undefined && marker.dataset.sidebarRightOccurrence !== held?.id) return undefined
  return { sessionId, paneId, host: pane.host, tabId, occurrence: held,
    navigationRevision: held?.navigation.getSnapshot().revision }
}

/**
 * Observe input ownership without retaining a historical pane selection.
 * @param document - product document whose sidebar owns the listener lifetime.
 * @param changed - refresh command availability from live focus and layout.
 * @returns disposer for every document/window listener.
 */
export function observeSidebarFocus(document: Document, changed: () => void): () => void {
  let active = true
  const pointer = (event: PointerEvent): void => {
    const element = event.composedPath().find(value => value instanceof Element)
    if (!(element instanceof Element)) return
    const pane = element.closest<HTMLElement>('[data-sidebar-right-session] [data-dockkit-pane], [data-sidebar-right-session] [data-dockkit-float]')
    const control = element.closest('button, input, textarea, select, a, [contenteditable], [tabindex], iframe')
    if (pane !== null && (control === null || control === pane)) {
      pane.focus({ preventScroll: true })
    }
    changed()
  }
  const blur = (): void => { queueMicrotask(() => { if (active) changed() }) }
  document.addEventListener('focusin', changed)
  document.addEventListener('focusout', changed)
  document.addEventListener('pointerdown', pointer, true)
  document.defaultView?.addEventListener('blur', blur)
  document.defaultView?.addEventListener('focus', changed)
  return () => {
    active = false
    document.removeEventListener('focusin', changed)
    document.removeEventListener('focusout', changed)
    document.removeEventListener('pointerdown', pointer, true)
    document.defaultView?.removeEventListener('blur', blur)
    document.defaultView?.removeEventListener('focus', changed)
  }
}
