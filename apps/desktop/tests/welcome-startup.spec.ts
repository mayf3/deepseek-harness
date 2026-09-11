/** Preview startup must use the same Host and workspace transition as ordinary Desktop startup. */

import { afterEach, expect, it, vi } from 'vitest'
import type { WelcomeOperations } from '../src/welcome-api.ts'
import { DESKTOP_IPC } from '../src/ipc.ts'

const state = vi.hoisted(() => ({
  quit: vi.fn(),
  startHost: vi.fn().mockResolvedValue({ url: 'http://127.0.0.1:3080/?token=test' }),
  stopHost: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  loadWorkspace: vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined),
  showWorkspace: vi.fn(),
  closeWelcome: vi.fn(),
  welcomeLocale: undefined as unknown,
  preference: 'zh',
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => void>(),
  contents: undefined as unknown,
  windowOptions: undefined as unknown,
  menu: vi.fn(),
  operations: undefined as WelcomeOperations | undefined,
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    name: 'Harness',
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    getLocale: () => 'en',
    getAppPath: () => '/development-app',
    getPreferredSystemLanguages: () => ['en-US'],
    on: vi.fn(),
    quit: state.quit,
    exit: vi.fn(),
  },
  BrowserWindow: class {
    constructor(options: unknown) { state.windowOptions = options }
    private ready: (() => void) | undefined
    webContents = { mainFrame: { url: 'http://127.0.0.1:3080/?token=test' }, setWindowOpenHandler: vi.fn(), on: vi.fn(), send: vi.fn(), openDevTools: vi.fn() }
    static getAllWindows() { return [] }
    once(name: string, callback: () => void) { if (name === 'ready-to-show') this.ready = callback; return this }
    on() { return this }
    isDestroyed() { return false }
    hide = vi.fn()
    show = state.showWorkspace
    async loadURL(url: string) { state.contents = this.webContents; await state.loadWorkspace(url); this.ready?.() }
  },
  net: { fetch: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  ipcMain: {
    handle: (name: string, callback: (...args: unknown[]) => unknown) => { state.handlers.set(name, callback) },
    on: (name: string, callback: (...args: unknown[]) => void) => { state.listeners.set(name, callback) },
  },
  dialog: { showErrorBox: vi.fn(), showMessageBox: vi.fn() },
  Menu: { buildFromTemplate: state.menu, setApplicationMenu: vi.fn() },
}))

vi.mock('../src/paths.ts', () => ({ resolveDesktopPaths: () => ({ profile: '/profile' }) }))
vi.mock('../src/project-manager.ts', () => ({ DesktopProjectManager: class {
  applyRelease = vi.fn(async () => {})
  canRecoverProfile = vi.fn(() => true)
} }))
vi.mock('../src/host-process.ts', () => ({
  DesktopHostProcess: class {
    start = state.startHost
    stop = state.stopHost
    fetch() { return Promise.resolve(Response.json({ hasApiKey: true, writable: true, localePreference: state.preference })) }
  },
}))
vi.mock('../src/welcome-backend.ts', () => ({
  connectDesktopWelcome: async () => ({
    read: async () => ({ hasApiKey: true, writable: true, localePreference: state.preference }),
    save: async () => ({ ok: true }),
  }),
}))
vi.mock('../src/update-coordinator.ts', () => ({ DesktopUpdateCoordinator: vi.fn() }))
vi.mock('../src/welcome-window.ts', () => ({
  openWelcomeWindow: (locale: unknown, operations: WelcomeOperations) => {
    state.welcomeLocale = locale
    state.operations = operations
    return Promise.resolve({ once: vi.fn(), close: state.closeWelcome })
  },
}))

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

it('starts the Host for a forced welcome preview and opens the workspace on skip without quitting', async () => {
  vi.useFakeTimers()
  vi.spyOn(process, 'argv', 'get').mockReturnValue(['electron', 'desktop', '--preview-welcome'])
  vi.stubEnv('DSH_DESKTOP_DEV_PROJECT_DIR', '/development-profile')
  vi.stubEnv('DSH_DESKTOP_NODE_BINARY', '/runtime/node')
  vi.stubEnv('DSH_DESKTOP_PNPM_ENTRY', '/runtime/pnpm')
  vi.stubEnv('DSH_DESKTOP_DSH_DIR', '/runtime/dsh')
  vi.stubEnv('DSH_DESKTOP_HOST_INSPECT_PORT', undefined)
  vi.stubEnv('DSH_DESKTOP_OPEN_DEVTOOLS', '0')
  await import('../src/main.ts')
  await vi.waitFor(() => { expect(state.operations).toBeDefined() })
  expect(state.startHost).toHaveBeenCalledOnce()
  expect(state.loadWorkspace).toHaveBeenCalledExactlyOnceWith('dsh-app://shell/startup.html')
  expect(state.showWorkspace).not.toHaveBeenCalled()
  state.loadWorkspace.mockClear()
  expect(state.welcomeLocale).toMatchObject({ id: 'zh-CN' })
  await state.operations!.skip()
  expect(state.loadWorkspace).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:3080/?token=test')
  expect(state.showWorkspace).toHaveBeenCalledOnce()
  expect(state.windowOptions).toMatchObject({
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 18 }, vibrancy: 'sidebar' } : {}),
    webPreferences: { contextIsolation: true, sandbox: true },
  })
  expect(state.closeWelcome).toHaveBeenCalledOnce()
  expect(state.quit).not.toHaveBeenCalled()
  expect(state.stopHost).not.toHaveBeenCalled()
  const contents = state.contents as { mainFrame: { url: string } }
  const event = { sender: contents, senderFrame: contents.mainFrame }
  const bootstrap = state.handlers.get(DESKTOP_IPC.localeBootstrap)!
  expect(await bootstrap(event)).toEqual({ languages: ['en-US'], preference: 'zh' })
  state.preference = 'en'
  expect(await bootstrap(event)).toEqual({ languages: ['en-US'], preference: 'en' })
  const changed = state.listeners.get(DESKTOP_IPC.localeChanged)!
  const initialMenus = state.menu.mock.calls.length
  changed({ ...event, senderFrame: {} }, 'en')
  changed(event, 42)
  expect(state.menu).toHaveBeenCalledTimes(initialMenus)
  changed(event, 'en')
  expect(state.menu).toHaveBeenCalledTimes(initialMenus + 1)
  const shell = { senderFrame: { url: 'dsh-app://shell/plugin-manager.html' } }
  expect(await state.handlers.get(DESKTOP_IPC.localeGet)!(shell)).toMatchObject({ id: 'en' })
})
