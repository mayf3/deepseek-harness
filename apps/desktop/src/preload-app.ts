/** Context-isolated application boot, local directory picker, and desktop carrier marker. */

import { contextBridge, ipcRenderer } from 'electron'
import { DESKTOP_IPC, SCHEME } from './ipc.ts'
import { markDocumentPlatform } from './preload-platform.ts'
import { syncNativeTheme } from './preload-theme.ts'
import { syncWindowsAppearance } from './preload-windows.ts'

if (location.protocol === `${SCHEME}:` && location.hostname === 'app') {
  syncWindowsAppearance()
  contextBridge.exposeInMainWorld('__DSH_DIRECTORY_PICKER__', {
    pick: () => ipcRenderer.invoke(DESKTOP_IPC.directoryPick) as Promise<string | null>,
  })
  contextBridge.exposeInMainWorld('dshDesktopBoot', {
    ready: () => ipcRenderer.invoke(DESKTOP_IPC.boot) as Promise<unknown>,
    failed: (message: string) => ipcRenderer.invoke(DESKTOP_IPC.bootFailed, message) as Promise<void>,
  })
}

markDocumentPlatform()
syncNativeTheme()
contextBridge.exposeInMainWorld('dshDesktop', { protocolVersion: 1 })
