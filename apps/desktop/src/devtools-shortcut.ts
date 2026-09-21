/** Shared desktop DevTools shortcuts respect shell-owned update overlays. */
import type { WebContents } from 'electron'
import { hasUpdateOverlay } from './update-overlay.ts'

/**
 * Install F12 and macOS Command+Option+I on one renderer for its lifetime.
 * @param contents - Renderer whose DevTools may open while no update overlay is attached.
 */
export function installDevToolsShortcut(contents: {
  on(event: 'before-input-event', listener: (event: Electron.Event, input: Electron.Input) => void): unknown
  openDevTools: WebContents['openDevTools']
}): void {
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.isAutoRepeat || hasUpdateOverlay(contents)) return
    const f12 = input.key === 'F12' && !input.meta && !input.alt && !input.control && !input.shift
    const macShortcut = process.platform === 'darwin' && input.code === 'KeyI'
      && input.meta && input.alt && !input.control && !input.shift
    if (!f12 && !macShortcut) return
    event.preventDefault()
    contents.openDevTools({ mode: 'detach' })
  })
}
