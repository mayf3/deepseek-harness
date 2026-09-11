/** Localized welcome copy and write-only credential actions. */

import { contextBridge, ipcRenderer } from 'electron'
import { resolveDesktopLocale } from './locale.ts'
import { WELCOME_IPC, type WelcomeApi, type WelcomeSaveResult } from './welcome-api.ts'

const prefix = '--dsh-welcome-locale='
const locale = process.argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length)
if (locale === undefined) throw new Error('desktop welcome: missing window locale')
const api: WelcomeApi = {
  ...resolveDesktopLocale(locale),
  saveApiKey: (value: string) => ipcRenderer.invoke(WELCOME_IPC.saveApiKey, value) as Promise<WelcomeSaveResult>,
  skip: () => ipcRenderer.invoke(WELCOME_IPC.skip) as Promise<void>,
}
contextBridge.exposeInMainWorld('dshWelcome', api)
