/** Origin-scoped boot bridge and read-only update presentation with native confirmation actions. */

import { contextBridge, ipcRenderer } from 'electron'
import { DESKTOP_IPC, type DshDesktopProductApi, type DesktopUpdatePresentation } from './ipc.ts'
import { markDocumentPlatform } from './preload-platform.ts'
import { syncNativeTheme } from './preload-theme.ts'

const product: DshDesktopProductApi = {
  protocolVersion: 1,
  updates: {
    status: () => ipcRenderer.invoke(DESKTOP_IPC.updatesStatus) as Promise<DesktopUpdatePresentation>,
    open: () => ipcRenderer.invoke(DESKTOP_IPC.updatesOpen) as Promise<void>,
    subscribe(listener) {
      const handle = (_event: Electron.IpcRendererEvent, state: DesktopUpdatePresentation): void => { listener(state) }
      ipcRenderer.on(DESKTOP_IPC.updatesPresentation, handle)
      return () => { ipcRenderer.off(DESKTOP_IPC.updatesPresentation, handle) }
    },
  },
}

if (location.protocol === 'dsh-app:' && location.hostname === 'app') {
  contextBridge.exposeInMainWorld('dshDesktopBoot', {
    ready: () => ipcRenderer.invoke(DESKTOP_IPC.boot) as Promise<unknown>,
    failed: (message: string) => ipcRenderer.invoke(DESKTOP_IPC.bootFailed, message) as Promise<void>,
  })
}

markDocumentPlatform()
syncNativeTheme()
// Main-process IPC also verifies the owning window and top frame.
contextBridge.exposeInMainWorld('dshDesktop', location.protocol === 'dsh-app:' && location.hostname === 'app' ? product : { protocolVersion: 1 })
