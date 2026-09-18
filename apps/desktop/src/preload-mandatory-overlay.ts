/** Mounts the shell-owned Windows update document inside the main window's content area. */
import { ipcRenderer } from 'electron'
import { MANDATORY_IPC } from './mandatory-update-ipc.ts'
import type { MandatoryUpdateView } from './mandatory-update-window.ts'
import { WINDOWS_TITLEBAR_HEIGHT } from './windows-layout.ts'

/** Keep privileged update actions in the isolated preload, accepting messages only from its owned shell frame. */
export function installMandatoryUpdateOverlay(): void {
  let state: MandatoryUpdateView | undefined
  let host: HTMLDivElement | undefined
  let frame: HTMLIFrameElement | undefined
  let closing: ReturnType<typeof setTimeout> | undefined
  const publish = (): void => { frame?.contentWindow?.postMessage({ type: 'dsh-mandatory-state', state }, 'dsh-app://shell') }
  const remove = (): void => { host?.remove(); host = undefined; frame = undefined }
  const render = (): void => {
    if (state === undefined || document.readyState === 'loading') return
    clearTimeout(closing)
    if (!state.policy.blocking) {
      publish()
      closing = setTimeout(remove, 150)
      return
    }
    if (frame === undefined) {
      host = document.createElement('div')
      host.style.cssText = `position:fixed;top:${WINDOWS_TITLEBAR_HEIGHT}px;left:0;right:0;bottom:0;z-index:2147483647;backdrop-filter:blur(2px)`
      const shadow = host.attachShadow({ mode: 'closed' })
      frame = document.createElement('iframe')
      frame.title = state.locale.messages.mandatoryTitle
      frame.style.cssText = 'display:block;width:100%;height:100%;border:0;background:transparent'
      frame.src = 'dsh-app://shell/mandatory-update.html'
      shadow.append(frame)
      document.documentElement.append(host)
      frame.addEventListener('load', () => { publish(); frame?.focus() })
    }
    publish()
  }
  const receive = (_event: Electron.IpcRendererEvent, next: MandatoryUpdateView): void => { state = next; render() }
  const message = (event: MessageEvent<unknown>): void => {
    if (frame === undefined || frame.contentWindow === null || event.source !== frame.contentWindow || event.origin !== 'dsh-app://shell') return
    const value = event.data
    if (typeof value !== 'object' || value === null || !('type' in value)) return
    if (value.type === 'dsh-mandatory-ready') { publish(); return }
    if (value.type !== 'dsh-mandatory-action' || !('id' in value) || !Number.isSafeInteger(value.id)
      || !('action' in value) || !('version' in value) || !('revision' in value)) return
    const target = frame.contentWindow
    void ipcRenderer.invoke(MANDATORY_IPC.action, value.action, value.version, value.revision).then(
      () => { target.postMessage({ type: 'dsh-mandatory-result', id: value.id, ok: true }, 'dsh-app://shell') },
      () => { target.postMessage({ type: 'dsh-mandatory-result', id: value.id, ok: false }, 'dsh-app://shell') },
    )
  }
  const blockBackgroundKey = (event: KeyboardEvent): void => {
    if (frame === undefined || state?.policy.blocking !== true) return
    event.preventDefault()
    event.stopImmediatePropagation()
    frame.focus()
  }
  ipcRenderer.on(MANDATORY_IPC.state, receive)
  window.addEventListener('message', message)
  window.addEventListener('keydown', blockBackgroundKey, true)
  window.addEventListener('DOMContentLoaded', render, { once: true })
  window.addEventListener('pagehide', () => {
    clearTimeout(closing)
    remove()
    ipcRenderer.off(MANDATORY_IPC.state, receive)
    window.removeEventListener('message', message)
    window.removeEventListener('keydown', blockBackgroundKey, true)
    window.removeEventListener('DOMContentLoaded', render)
  }, { once: true })
}
