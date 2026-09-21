/** Focus continuity after a close replaces docked or floating pane elements. */
import { flushSync } from 'react-dom'
import type { PaneId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * Commit a focused page's removal before focusing a surviving visible pane.
 * @param document - product document owning the input focus.
 * @param sessionId - Session whose page is closing.
 * @param paneId - pane whose page is closing; preferred if it survives.
 * @param close - synchronous cleanup and layout removal; errors preserve focus.
 */
export function closeWithPaneFocus(document: Document, sessionId: SessionId, paneId: PaneId, close: () => void): void {
  const before = document.activeElement
  const owner = before?.closest<HTMLElement>('[data-sidebar-right-session]')
  const source = before?.closest<HTMLElement>('[data-dockkit-pane], [data-dockkit-float]')
  const retain = owner?.dataset.sidebarRightSession === sessionId
    && (source?.dataset.dockkitPane ?? source?.dataset.dockkitFloat) === paneId
  flushSync(close)
  if (!retain || (document.activeElement !== document.body && document.activeElement !== before)) return
  const panes = [...document.querySelectorAll<HTMLElement>('[data-dockkit-pane], [data-dockkit-float]')]
    .filter((pane) => {
      const owner = pane.closest<HTMLElement>('[data-sidebar-right-session]')
      return owner?.dataset.sidebarRightSession === sessionId
        && (pane.hasAttribute('data-dockkit-float') || owner.hasAttribute('data-sidebar-right-open'))
    })
  const next = panes.find(pane => (pane.dataset.dockkitPane ?? pane.dataset.dockkitFloat) === paneId)
    ?? panes.find(pane => pane.hasAttribute('data-dockkit-pane-active')) ?? panes[0]
  next?.focus({ preventScroll: true })
}
