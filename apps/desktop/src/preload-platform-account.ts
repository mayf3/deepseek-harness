/** Platform initialization copies credentials once; token getters never perform IPC. */
import { contextBridge, ipcRenderer } from 'electron'
import { PLATFORM_IPC } from './platform-ipc.ts'

const originArgument = '--dsh-platform-origin='
const allowedOrigin = process.argv.find(argument => argument.startsWith(originArgument))?.slice(originArgument.length)
if (process.isMainFrame && location.origin === allowedOrigin) {
  let token: string | undefined
  try {
    const value: unknown = ipcRenderer.sendSync(PLATFORM_IPC.bootstrap)
    if (typeof value === 'object' && value !== null && 'token' in value && 'origin' in value
      && typeof value.token === 'string' && value.token.length > 0 && value.origin === location.origin) token = value.token
  } catch {
    // Initialization failure retains embedded mode so Platform cannot use browser credentials.
  }
  contextBridge.exposeInMainWorld('dsh', {
    protocolVersion: 1,
    displayMode: 'embedded',
    getAuthToken: (): string => {
      if (token === undefined) throw new Error('Platform initialization failed')
      return token
    },
  })
}
