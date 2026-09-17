/** Electron shell: desktop project ownership, custom protocol, windows, and lifecycle. */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  protocol,
  session,
  shell,
  type MenuItemConstructorOptions,
} from 'electron'
import { resolveDesktopPaths } from './paths.ts'
import { DesktopProjectManager } from './project-manager.ts'
import { DesktopHostProcess } from './host-process.ts'
import { installDesktopDirectoryPicker } from './directory-picker.ts'
import { DesktopBackendController } from './backend-controller.ts'
import { DESKTOP_IPC, SCHEME, assertDesktopSender } from './ipc.ts'
import { formatDesktopMessage, resolveDesktopLocale } from './locale.ts'
import { claimDesktopSingleInstance } from './single-instance.ts'
import { DesktopUpdateCoordinator } from './update-coordinator.ts'
import { serveWebDocument, authenticateWebHost, forwardWebRequest } from './web-document.ts'
import { DesktopFatalRecovery } from './fatal-recovery.ts'

let focusPrimaryWindow = (): void => {}
let stopForRecovery = async (): Promise<void> => {}
let shuttingDown = false
const recovery = new DesktopFatalRecovery({
  messages: () => resolveDesktopLocale(app.getLocale()),
  show: options => dialog.showMessageBox(options),
  stop: () => { shuttingDown = true; return stopForRecovery() },
  disablePlugins: async () => {
    const manager = new DesktopProjectManager(resolveDesktopPaths(), runtimeResources())
    const backupPath = await manager.disableAllPlugins()
    console.info('Desktop profile recovery completed:', { profilePatchBackup: backupPath ?? null, homePatch: 'unchanged' })
  },
  exit: () => { app.quit() },
  restart: () => { app.relaunch(); app.quit() },
})

function reportFatal(error: unknown): void {
  console.error(error)
  if (shuttingDown) return
  void recovery.report(error).catch((failure: unknown) => { console.error(failure); app.exit(1) })
}

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
    codeCache: true,
  },
}])

interface RuntimeResources {
  readonly nodeBin: string
  readonly node: string
  readonly pnpm: string
  readonly dsh: string
}

function runtimeResources(): RuntimeResources {
  const development = !app.isPackaged
  const node = process.execPath
  const nodeBin = development ? join(app.getAppPath(), 'scripts', 'node-bin') : join(process.resourcesPath, 'runtime', 'bin')
  const pnpm = (development ? process.env.DSH_DESKTOP_PNPM_ENTRY : undefined)
    ?? (development ? join(app.getAppPath(), 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')
      : join(process.resourcesPath, 'runtime', 'pnpm', 'bin', 'pnpm.mjs'))
  const dsh = (development ? process.env.DSH_DESKTOP_DSH_DIR : undefined)
    ?? (development ? join(app.getAppPath(), '.desktop-build', 'development', 'project') : join(app.getAppPath(), 'dsh'))
  return { node, nodeBin, pnpm, dsh }
}

function developmentHostInspectPort(enabled: boolean): number | undefined {
  const configured = process.env.DSH_DESKTOP_HOST_INSPECT_PORT
  if (!enabled || configured === undefined || configured === '') return undefined
  const port = Number(configured)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('dsh desktop: DSH_DESKTOP_HOST_INSPECT_PORT must be an integer from 1 through 65535')
  }
  return port
}

function createWindow(preload: string, show = false): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 880,
    minHeight: 600,
    show,
    // hiddenInset places traffic lights inside the sidebar; sidebar vibrancy
    // needs a transparent window background to show through the page.
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hiddenInset' as const,
      trafficLightPosition: { x: 16, y: 18 },
      vibrancy: 'sidebar' as const,
      // 'active' keeps the vibrancy material stable when the window blurs;
      // 'followWindow' washes the sidebar out behind an unfocused window.
      visualEffectState: 'active' as const,
      backgroundColor: '#00000000',
    } : {}),
    webPreferences: {
      preload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (['http:', 'https:'].includes(new URL(url).protocol)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('context-menu', (_event, { isEditable, selectionText, editFlags }) => {
    const items: MenuItemConstructorOptions[] = []
    if (isEditable) {
      items.push(
        { role: 'undo', enabled: editFlags.canUndo },
        { role: 'redo', enabled: editFlags.canRedo },
        { type: 'separator' },
        { role: 'cut', enabled: editFlags.canCut },
        { role: 'copy', enabled: editFlags.canCopy },
        { role: 'paste', enabled: editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll', enabled: editFlags.canSelectAll },
      )
    } else if (selectionText.length > 0) {
      items.push({ role: 'copy', enabled: editFlags.canCopy })
    }
    // Empty accelerators suppress Electron's default shortcut labels for native roles.
    if (items.length > 0) Menu.buildFromTemplate(items.map(item => ({ ...item, accelerator: '' }))).popup({ window })
  })
  window.webContents.on('will-navigate', (event, url) => {
    const destination = new URL(url)
    const current = new URL(window.webContents.getURL())
    if (destination.protocol !== `${SCHEME}:`
      && !(destination.protocol === 'http:' && destination.origin === current.origin)) {
      event.preventDefault()
      if (['http:', 'https:'].includes(destination.protocol)) void shell.openExternal(url)
    }
  })
  return window
}

async function main(): Promise<void> {
  const resources = runtimeResources()
  const paths = resolveDesktopPaths()
  const development = !app.isPackaged
  const activeProject = paths.profile
  const manager = new DesktopProjectManager(paths, resources)
  let quitting = false
  let startup: Promise<void> | undefined
  let mainWindow: BrowserWindow | undefined
  let shellInstallerOwnsQuit = false
  const messages = resolveDesktopLocale(app.getLocale())
  const appPreload = fileURLToPath(new URL('./preload-app.cjs', import.meta.url))
  const applicationUrl = `${SCHEME}://app/`
  let hostUrl: string | undefined
  let hostCookie: string | undefined
  let injections: readonly unknown[] = []
  let navigation: { window: BrowserWindow; url: string; promise: Promise<void> } | undefined
  const navigateMain = (url: string): Promise<void> => {
    const window = mainWindow
    if (quitting || window === undefined || window.isDestroyed()) return Promise.resolve()
    if (navigation?.window === window && navigation.url === url) return navigation.promise
    const next = { window, url, promise: Promise.resolve() }
    next.promise = window.loadURL(url).catch((error: unknown) => {
      if (quitting || shuttingDown || window.isDestroyed() || navigation !== next
        || (error instanceof Error && 'code' in error && error.code === 'ERR_ABORTED')) return
      navigation = undefined
      throw error
    })
    navigation = next
    return next.promise
  }
  const backend = new DesktopBackendController((onFailure) => {
    const hostInspectPort = developmentHostInspectPort(development)
    const host = new DesktopHostProcess(resources.node, resources.dsh, activeProject,
      hostInspectPort, process.env, onFailure,
      development ? join(app.getAppPath(), '.desktop-build', 'targets', `${process.platform === 'darwin' ? 'mac' : 'win'}-${process.arch}`, 'runtime', 'primary-runtime')
        : join(process.resourcesPath, 'runtime', 'primary-runtime'),
      development ? 'link' : 'runtime', resources)
    return {
      start: async () => {
        const ready = await host.start()
        hostCookie = await authenticateWebHost(ready.url)
        hostUrl = ready.url
        if (ready.injections === undefined) throw new Error('Desktop Host did not provide boot injections')
        injections = ready.injections
      },
      stop: () => host.stop(),
    }
  }, (state) => {
    if (state.phase === 'error') reportFatal(new Error(state.message))
  })

  stopForRecovery = () => backend.close()

  const reconcileBackend = (): Promise<void> => {
    startup ??= (async () => {
      await navigateMain(applicationUrl)
      await backend.start(async () => {
        await manager.applyRelease(app.isPackaged)
      })
      // The existing Web document resumes through the boot IPC response.
    })().catch((error: unknown) => {
      reportFatal(error)
      throw error
    }).finally(() => { startup = undefined })
    return startup
  }

  const updates = new DesktopUpdateCoordinator(
    async () => {
      shellInstallerOwnsQuit = true
      await backend.stop()
    },
  )

  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url)
    if (url.hostname === 'app') {
      if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname.startsWith('/assets/')
        || ['/favicon.svg', '/manifest.webmanifest'].includes(url.pathname)) {
        return serveWebDocument(request, join(resources.dsh, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist'))
      }
      if (backend.host === undefined || hostUrl === undefined || hostCookie === undefined) {
        return Promise.resolve(new Response(null, { status: 503 }))
      }
      return forwardWebRequest(request, hostUrl, hostCookie)
    }
    return Promise.resolve(new Response(null, { status: 404 }))
  })

  installDesktopDirectoryPicker(() => mainWindow)

  ipcMain.handle(DESKTOP_IPC.boot, async (event) => {
    assertDesktopSender(event, ['app'])
    await startup
    if (backend.host === undefined || hostUrl === undefined) throw new Error('Desktop Host is unavailable')
    return { injections, streamBaseUrl: new URL(hostUrl).origin }
  })

  ipcMain.handle(DESKTOP_IPC.bootFailed, (event, message: unknown) => {
    assertDesktopSender(event, ['app'])
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('dsh desktop: rejected startup failure from a non-primary frame')
    }
    if (typeof message !== 'string') throw new Error('dsh desktop: startup failure must be text')
    reportFatal(new Error(message))
  })

  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['ws://127.0.0.1/*'] }, (details, callback) => {
    if (hostUrl === undefined || hostCookie === undefined || details.webContentsId !== mainWindow?.webContents.id) {
      callback({})
      return
    }
    const target = new URL(hostUrl)
    const requested = new URL(details.url)
    if (requested.host !== target.host) { callback({}); return }
    const headers = Object.fromEntries(Object.entries(details.requestHeaders).map(([name, value]) => [name.toLowerCase(), value]))
    if (headers.origin !== 'dsh-app://app') { callback({ cancel: true }); return }
    callback({ requestHeaders: { ...headers, origin: target.origin, cookie: hostCookie, 'sec-fetch-site': 'same-origin' } })
  })

  // Only the main window may synchronize its palette with the native material.
  ipcMain.on(DESKTOP_IPC.nativeThemeSet, (event, source: unknown) => {
    if (mainWindow === undefined || event.sender !== mainWindow.webContents) return
    if (source === 'light' || source === 'dark' || source === 'system') nativeTheme.themeSource = source
  })
  const checkAndPrompt = async (manual: boolean): Promise<void> => {
    const state = await updates.check()
    if (state.phase === 'error') {
      if (manual) {
        await dialog.showMessageBox({
          type: 'error',
          title: messages.updateCheckFailedTitle,
          message: state.message ?? messages.unknownError,
        })
      }
      return
    }
    if (state.phase !== 'available') {
      if (manual) {
        await dialog.showMessageBox({
          type: 'info',
          title: messages.updateCheckTitle,
          message: state.message ?? messages.updateCurrent,
        })
      }
      return
    }
    const result = await dialog.showMessageBox({
      type: 'info',
      title: messages.updateTitle,
      message: messages.updateAvailable,
      detail: formatDesktopMessage(messages.updateDetail, { version: state.version ?? '' }),
      buttons: [messages.installAndRestart, messages.later],
      defaultId: 0,
      cancelId: 1,
    })
    if (result.response !== 0) return
    const installed = await updates.install()
    if (installed.phase === 'error') {
      await dialog.showMessageBox({
        type: 'error',
        title: messages.updateFailedTitle,
        message: installed.message ?? messages.unknownError,
      })
    }
  }

  // A custom application menu replaces Electron's default menu, so macOS needs
  // its standard menus and application hide commands declared explicitly.
  const darwin = process.platform === 'darwin'
  const platformMenus: MenuItemConstructorOptions[] = darwin
    ? [{ role: 'fileMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]
    : [{ role: 'editMenu' }]
  const hideCommands: MenuItemConstructorOptions[] = darwin
    ? [{ role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }]
    : []
  Menu.setApplicationMenu(Menu.buildFromTemplate([{
    label: darwin ? app.name : messages.application,
    submenu: [
      { label: messages.checkUpdatesMenu, click: () => { void checkAndPrompt(true) } },
      { type: 'separator' },
      ...hideCommands,
      { role: 'quit' },
    ],
  }, ...platformMenus]))

  const createMainWindow = (): BrowserWindow => {
    const window = createWindow(appPreload, true)
    mainWindow = window
    window.on('closed', () => { if (mainWindow === window) mainWindow = undefined })
    window.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (isMainFrame && code !== -3 && !quitting && !window.isDestroyed()) {
        reportFatal(new Error(`Desktop page failed to load: ${url} (${String(code)}: ${description})`))
      }
    })
    window.webContents.on('preload-error', (_event, _path, error) => {
      if (!quitting && !window.isDestroyed()) reportFatal(error)
    })
    window.webContents.on('render-process-gone', (_event, details) => {
      navigation = undefined
      if (!quitting && !window.isDestroyed() && details.reason !== 'clean-exit') {
        reportFatal(new Error(`Desktop renderer exited: ${details.reason}`))
      }
    })
    return window
  }
  focusPrimaryWindow = () => {
    const window = mainWindow
    if (window === undefined || window.isDestroyed()) {
      try { createMainWindow() } catch (error) { reportFatal(error); return }
      void navigateMain(applicationUrl).catch(reportFatal)
      return
    }
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) focusPrimaryWindow()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('before-quit', (event) => {
    shuttingDown = true
    if (shellInstallerOwnsQuit || quitting) return
    event.preventDefault()
    quitting = true
    void backend.close().catch((error: unknown) => { console.error(error) }).finally(() => { app.quit() })
  })

  mainWindow = createMainWindow()
  await reconcileBackend().catch(() => undefined)
  // Window lifecycle callbacks run while backend startup is pending.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (quitting) return
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (mainWindow !== undefined && development && process.env.DSH_DESKTOP_OPEN_DEVTOOLS !== '0') {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }
  setTimeout(() => { void checkAndPrompt(false) }, 10_000)
}

const ownsDesktopInstance = claimDesktopSingleInstance(app, () => { focusPrimaryWindow() })

if (ownsDesktopInstance) void app.whenReady().then(main).catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(error)
  const diagnosticFile = process.env.DSH_DESKTOP_DIAGNOSTIC_FILE
  if (diagnosticFile !== undefined) {
    await writeFile(diagnosticFile, `${error instanceof Error ? error.stack ?? message : message}\n`).catch(() => undefined)
  }
  reportFatal(error)
}).catch((error: unknown) => {
  console.error(error)
  app.exit(1)
})
