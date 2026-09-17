import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron'
import { join } from 'node:path'
import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import { DESKTOP_IPC } from '../src/ipc.ts'
import { en } from '../src/locale.ts'

vi.mock('../src/web-document.ts', () => ({ authenticateWebHost: async () => 'test-cookie', serveWebDocument: vi.fn(), forwardWebRequest: vi.fn() }))

const harness = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  function deferred() {
    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((accept, decline) => { resolve = accept; reject = decline })
    return { promise, resolve, reject }
  }
  const windows: FakeWindow[] = []
  let windowFailure: Error | undefined
  const hosts: FakeHost[] = []
  const handlers = new Map<string, (event: { senderFrame: { url: string } }, ...args: unknown[]) => unknown>()
  let pluginsEnabled = false
  let preparing = deferred()
  let prepared = deferred()
  let hostStarted = deferred()
  let navigated = deferred()
  let dialogShown = deferred()
  let quitCompleted = deferred()
  class FakeWindow extends EventEmitter {
    destroyed = false
    readonly urls: string[] = []
    readonly webContents = Object.assign(new EventEmitter(), {
      id: 42,
      mainFrame: { url: 'dsh-app://app/' },
      setWindowOpenHandler: vi.fn(),
      openDevTools: vi.fn(),
      getURL: () => this.urls.at(-1) ?? '',
      send: vi.fn(),
    })
    readonly show = vi.fn()
    readonly focus = vi.fn()
    readonly restore = vi.fn()
    constructor(readonly options: { show: boolean }) { super(); if (windowFailure !== undefined) throw windowFailure; windows.push(this) }
    isDestroyed() { return this.destroyed }
    isMinimized() { return false }
    async loadURL(url: string) {
      this.urls.push(url)
      if (url === 'dsh-app://app/') navigated.resolve()
    }
    static getAllWindows() { return windows.filter(window => !window.destroyed) }
    close() { this.destroyed = true; this.emit('closed') }
  }
  class FakeHost {
    url = 'http://127.0.0.1:3080/?token=test'
    readonly ready = deferred()
    readonly exited = deferred()
    readonly stopping = deferred()
    readonly start = vi.fn(() => { hostStarted.resolve(); return this.ready.promise.then(() => ({ url: this.url, injections: [] })) })
    readonly stop = vi.fn(() => {
      this.stopping.resolve()
      this.ready.reject(new Error('child stopped'))
      return this.exited.promise
    })
    constructor(
      readonly node: string, readonly runtime: string, readonly profile: string,
      readonly inspectPort?: number, readonly environment?: NodeJS.ProcessEnv, readonly onFailure?: (error: Error) => void,
      readonly primaryRuntime?: string, readonly profileResolution?: string,
      readonly packageManager?: { pnpm: string; nodeBin: string },
    ) { hosts.push(this) }
  }
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true,
    name: 'Desktop test',
    whenReady: () => Promise.resolve(),
    getLocale: () => 'en-US',
    getVersion: () => '1.0.0',
    getAppPath: () => 'desktop-test-app',
    requestSingleInstanceLock: () => true,
    exit: vi.fn(),
    relaunch: vi.fn(),
    quit: vi.fn(() => {
      const event = { preventDefault: vi.fn() }
      app.emit('before-quit', event)
      if (event.preventDefault.mock.calls.length === 0) quitCompleted.resolve()
    }),
  })
  const popup = vi.fn()
  return {
    windows, hosts, handlers, app, FakeWindow, FakeHost,
    failWindow(error: Error) { windowFailure = error },
    popup,
    protocolHandle: vi.fn<(scheme: string, handler: (request: Request) => Promise<Response>) => void>(),
    socketHeaders: vi.fn(),
    menu: {
      setApplicationMenu: vi.fn(),
      buildFromTemplate: vi.fn((_items: MenuItemConstructorOptions[]) => ({ popup })),
    },
    dialog: {
      showOpenDialog: vi.fn(),
      showErrorBox: vi.fn(),
      showMessageBox: vi.fn<(options: MessageBoxOptions) => Promise<MessageBoxReturnValue>>(),
    },
    openExternal: vi.fn(),
    applyRelease: vi.fn(() => { preparing.resolve(); return prepared.promise }),
    disableAllPlugins: vi.fn(async () => {
      pluginsEnabled = false
      return 'desktop-test-profile/cordis.patch.yml.bak-1789555200000'
    }),
    get preparing() { return preparing }, get prepared() { return prepared },
    get hostStarted() { return hostStarted }, get navigated() { return navigated },
    get dialogShown() { return dialogShown }, get quitCompleted() { return quitCompleted },
    nextNavigation() { navigated = deferred(); return navigated.promise },
    get pluginsEnabled() { return pluginsEnabled },
    set pluginsEnabled(value: boolean) { pluginsEnabled = value },
    reset() {
      windows.length = 0; hosts.length = 0; handlers.clear(); app.removeAllListeners()
      app.isPackaged = true
      windowFailure = undefined
      pluginsEnabled = false
      preparing = deferred(); prepared = deferred(); hostStarted = deferred()
      navigated = deferred(); dialogShown = deferred(); quitCompleted = deferred()
    },
  }
})

vi.mock('electron', () => ({
  app: harness.app,
  BrowserWindow: harness.FakeWindow,
  dialog: harness.dialog,
  shell: { openExternal: harness.openExternal },
  nativeTheme: { themeSource: 'system' },
  ipcMain: {
    on: vi.fn(),
    handle: (channel: string, handler: (event: { senderFrame: { url: string } }) => unknown) => { if (harness.handlers.has(channel)) throw new Error(`duplicate IPC handler ${channel}`); harness.handlers.set(channel, handler) },
  },
  Menu: harness.menu,
  session: { defaultSession: { webRequest: { onBeforeSendHeaders: harness.socketHeaders } } },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: harness.protocolHandle },
}))
vi.mock('../src/paths.ts', () => ({ resolveDesktopPaths: () => ({ profile: 'desktop-test-profile' }) }))
vi.mock('../src/project-manager.ts', () => ({
  DesktopProjectManager: class {
    readonly applyRelease = harness.applyRelease
    disableAllPlugins = harness.disableAllPlugins

  },
}))
vi.mock('../src/host-process.ts', () => ({ DesktopHostProcess: harness.FakeHost }))
vi.mock('../src/update-coordinator.ts', () => ({ DesktopUpdateCoordinator: vi.fn() }))

function invoke(channel: string, ...args: unknown[]): unknown {
  const handler = harness.handlers.get(channel)
  if (handler === undefined) throw new Error(`missing handler ${channel}`)
  return handler({ senderFrame: { url: 'dsh-app://app/' } }, ...args)
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.useFakeTimers()
  harness.reset()
  harness.dialog.showMessageBox.mockImplementation(() => { harness.dialogShown.resolve(); return new Promise(() => {}) })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.stubEnv('DSH_DESKTOP_PNPM_ENTRY', 'test-pnpm')
  vi.stubEnv('DSH_DESKTOP_DSH_DIR', 'test-runtime')
  vi.stubGlobal('process', { ...process, resourcesPath: 'desktop-test-resources' })
  vi.stubEnv('DSH_DESKTOP_HOST_INSPECT_PORT', undefined)
})

afterEach(async () => {
  harness.prepared.resolve()
  for (const host of harness.hosts) { host.ready.resolve(); host.exited.resolve() }
  harness.app.quit()
  await harness.quitCompleted.promise
  vi.restoreAllMocks()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('desktop main startup', () => {
  it('exposes application IPC and rejects the removed shell document', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    expect([...harness.handlers.keys()].sort()).toEqual([
      DESKTOP_IPC.boot, DESKTOP_IPC.bootFailed, DESKTOP_IPC.directoryPick,
    ].sort())
    const handler = harness.protocolHandle.mock.calls[0]![1]
    expect((await handler(new Request('dsh-app://shell/plugin-manager.html'))).status).toBe(404)
  })

  it.each(['darwin', 'win32', 'linux'] as const)('limits native titlebar styling to macOS on %s', async (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    expect(window.urls).toEqual(['dsh-app://app/'])
    if (platform === 'darwin') {
      expect(window.options).toMatchObject({ titleBarStyle: 'hiddenInset', vibrancy: 'sidebar', backgroundColor: '#00000000' })
    } else {
      expect(window.options).not.toHaveProperty('titleBarStyle')
      expect(window.options).not.toHaveProperty('vibrancy')
    }
    expect(harness.hosts).toHaveLength(0)
  })

  it.each(['darwin', 'win32', 'linux'] as const)('adds the standard macOS window commands only on macOS (%s)', async (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    await import('../src/main.ts')
    await harness.preparing.promise
    const describeItem = (item: MenuItemConstructorOptions): string | undefined =>
      item.role ?? (item.type === 'separator' ? 'separator' : item.label)
    const template = harness.menu.buildFromTemplate.mock.calls
      .map(call => call[0])
      .find(items => items.some(item => item.role === 'editMenu'))
    if (template === undefined) throw new Error('application menu missing')
    expect(template.map(describeItem)).toEqual(platform === 'darwin'
      ? ['Desktop test', 'fileMenu', 'editMenu', 'windowMenu']
      : ['Application', 'editMenu'])
    const application = template[0]!.submenu as MenuItemConstructorOptions[]
    expect(application.map(describeItem)).toEqual(platform === 'darwin'
      ? [en.checkUpdatesMenu, 'separator', 'hide', 'hideOthers', 'unhide', 'separator', 'quit']
      : [en.checkUpdatesMenu, 'separator', 'quit'])
    expect(harness.menu.setApplicationMenu).toHaveBeenCalledOnce()
  })

  it('attaches Host socket credentials only to the owned application origin and window', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    harness.hosts[0]!.ready.resolve()
    await Promise.resolve(invoke(DESKTOP_IPC.boot))
    const handler = harness.socketHeaders.mock.calls[0]![1] as (
      details: { url: string; webContentsId: number; requestHeaders: Record<string, string> },
      callback: (result: unknown) => void,
    ) => void
    const callback = vi.fn()
    const details = { url: 'ws://127.0.0.1:3080/api/remote.mux', webContentsId: 42, requestHeaders: { Origin: 'dsh-app://app' } }
    handler(details, callback)
    expect(callback).toHaveBeenLastCalledWith({ requestHeaders: {
      origin: 'http://127.0.0.1:3080', cookie: 'test-cookie', 'sec-fetch-site': 'same-origin',
    } })
    handler({ ...details, requestHeaders: { Origin: 'https://other.example' } }, callback)
    expect(callback).toHaveBeenLastCalledWith({ cancel: true })
    handler({ ...details, webContentsId: 43 }, callback)
    expect(callback).toHaveBeenLastCalledWith({})
    handler({ ...details, url: 'ws://127.0.0.1:9999/api/remote.mux' }, callback)
    expect(callback).toHaveBeenLastCalledWith({})
  })

  it('registers the window-owned directory picker during startup and rejects foreign callers', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    const handler = harness.handlers.get(DESKTOP_IPC.directoryPick) as (event: IpcMainInvokeEvent) => Promise<string | null>
    expect(handler).toBeTypeOf('function')
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame } as unknown as IpcMainInvokeEvent
    harness.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/workspace'] })
    await expect(handler(event)).resolves.toBe('/workspace')
    expect(harness.dialog.showOpenDialog).toHaveBeenCalledExactlyOnceWith(window, { properties: ['openDirectory', 'createDirectory'] })
    window.webContents.mainFrame.url = 'https://other.example/'
    await expect(handler(event)).rejects.toThrow('unowned renderer')
  })

  it('holds boot injections until the Host is ready and rejects foreign boot callers', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    const handler = harness.handlers.get(DESKTOP_IPC.boot)!
    await expect(handler({ senderFrame: { url: 'https://other.example/' } })).rejects.toThrow('unowned renderer')
    let settled = false
    const boot = Promise.resolve(handler({ senderFrame: { url: 'dsh-app://app/' } })).then((value) => { settled = true; return value })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(harness.windows[0]!.urls).toEqual(['dsh-app://app/'])
    harness.prepared.resolve()
    await harness.hostStarted.promise
    expect(settled).toBe(false)
    harness.hosts[0]!.ready.resolve()
    await expect(boot).resolves.toEqual({ injections: [], streamBaseUrl: 'http://127.0.0.1:3080' })
    expect(harness.windows[0]!.urls).toEqual(['dsh-app://app/'])
  })

  it('offers native editing actions on right-click and only copy for selected read-only text', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    const editFlags = { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: true, canSelectAll: true }
    harness.menu.buildFromTemplate.mockClear()

    window.webContents.emit('context-menu', {}, { isEditable: true, selectionText: 'text', editFlags })
    expect(harness.menu.buildFromTemplate).toHaveBeenLastCalledWith([
      { role: 'undo', enabled: true, accelerator: '' }, { role: 'redo', enabled: false, accelerator: '' },
      { type: 'separator', accelerator: '' },
      { role: 'cut', enabled: true, accelerator: '' }, { role: 'copy', enabled: true, accelerator: '' },
      { role: 'paste', enabled: true, accelerator: '' }, { type: 'separator', accelerator: '' },
      { role: 'selectAll', enabled: true, accelerator: '' },
    ])
    expect(harness.popup).toHaveBeenCalledWith({ window })

    window.webContents.emit('context-menu', {}, { isEditable: false, selectionText: 'text', editFlags })
    expect(harness.menu.buildFromTemplate).toHaveBeenLastCalledWith([{ role: 'copy', enabled: true, accelerator: '' }])

    harness.menu.buildFromTemplate.mockClear()
    window.webContents.emit('context-menu', {}, { isEditable: false, selectionText: '', editFlags })
    expect(harness.menu.buildFromTemplate).not.toHaveBeenCalled()
  })

  it('opens message links externally while retaining same-origin application navigation', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    harness.hosts[0]!.ready.resolve()
    await harness.navigated.promise
    const window = harness.windows[0]!
    const openWindow = window.webContents.setWindowOpenHandler.mock.calls[0]![0] as
      (details: { url: string }) => { action: string }
    const source = 'https://example.com/source?q=reference'
    expect(openWindow({ url: source })).toEqual({ action: 'deny' })
    expect(harness.openExternal).toHaveBeenCalledWith(source)
    harness.openExternal.mockClear()
    const external = { preventDefault: vi.fn() }
    window.webContents.emit('will-navigate', external, 'https://example.com/document')
    expect(external.preventDefault).toHaveBeenCalledOnce()
    expect(harness.openExternal).toHaveBeenCalledWith('https://example.com/document')
    harness.openExternal.mockClear()
    const internal = { preventDefault: vi.fn() }
    window.webContents.emit('will-navigate', internal, 'dsh-app://app/session/task-1')
    expect(internal.preventDefault).not.toHaveBeenCalled()
    expect(harness.openExternal).not.toHaveBeenCalled()
  })

  it('reports a window construction failure without requiring a window', async () => {
    const shown = Promise.withResolvers<undefined>()
    harness.dialog.showMessageBox.mockImplementation(() => { shown.resolve(undefined); return new Promise(() => {}) })
    harness.failWindow(new Error('window creation failed'))
    await import('../src/main.ts')
    await shown.promise
    expect(harness.windows).toHaveLength(0)
    expect(harness.dialog.showMessageBox.mock.calls[0]![0].detail).toContain('window creation failed')
  })

  it('accepts Web fatal reports only from the primary application frame', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    const frame = { url: 'dsh-app://app/' }
    Object.assign(window.webContents, { mainFrame: frame })
    const handler = harness.handlers.get(DESKTOP_IPC.bootFailed)! as unknown as (event: unknown, message: unknown) => void
    const event = { sender: window.webContents, senderFrame: frame }
    expect(() => { handler({ ...event, senderFrame: { url: 'https://other.example/' } }, 'untrusted') }).toThrow('unowned renderer')
    expect(() => { handler({ ...event, senderFrame: { ...frame } }, 'subframe') }).toThrow('non-primary frame')
    expect(() => { handler(event, {}) }).toThrow('must be text')
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled()
    handler(event, 'client mount failed')
    expect(harness.dialog.showMessageBox.mock.calls[0]![0].detail).toContain('client mount failed')
    expect(window.urls).toEqual(['dsh-app://app/'])
  })

  it('ignores subresource failures and navigation cancellation but reports a failed main document', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    window.webContents.emit('did-fail-load', {}, -2, 'failed', 'dsh-app://app/image.png', false)
    window.webContents.emit('did-fail-load', {}, -3, 'aborted', 'dsh-app://app/', true)
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled()
    window.webContents.emit('did-fail-load', {}, -2, 'failed', 'dsh-app://app/', true)
    expect(harness.dialog.showMessageBox.mock.calls[0]![0].detail).toContain('Desktop page failed to load')
  })

  it('offers all recovery choices when resources fail before the Host starts', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.reject(new Error('runtime resources missing'))
    await harness.dialogShown.promise
    expect(harness.dialog.showMessageBox.mock.calls[0]![0].detail).toContain('runtime resources missing')
    expect(harness.dialog.showMessageBox.mock.calls[0]![0].buttons).toEqual(['Exit', 'Restart', 'Disable third-party plugins, back up profile patch, and restart'])
    expect(harness.windows[0]!.urls).toEqual(['dsh-app://app/'])
  })

  it.each(['preload', 'renderer'])('retains the document after a fatal %s failure and reports only the first error', async (kind) => {
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    if (kind === 'preload') window.webContents.emit('preload-error', {}, 'preload-app.cjs', new Error('preload unavailable'))
    else window.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    window.webContents.emit('preload-error', {}, 'preload-app.cjs', new Error('secondary failure'))
    harness.prepared.reject(new Error('backend also failed'))
    await harness.dialogShown.promise
    expect(harness.dialog.showMessageBox).toHaveBeenCalledOnce()
    expect(harness.dialog.showMessageBox.mock.calls[0]![0].detail).not.toContain('secondary failure')
    expect(window.urls).toEqual(['dsh-app://app/'])
  })

  it('ignores clean renderer exits and exits of a closed window', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    window.webContents.emit('render-process-gone', {}, { reason: 'clean-exit' })
    window.close()
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('reports a rejected document load without navigating to a recovery page', async () => {
    const shown = Promise.withResolvers<undefined>()
    harness.dialog.showMessageBox.mockImplementation(() => { shown.resolve(undefined); return new Promise(() => {}) })
    vi.spyOn(harness.FakeWindow.prototype, 'loadURL').mockRejectedValueOnce(new Error('document missing'))
    await import('../src/main.ts')
    await shown.promise
    expect(harness.dialog.showMessageBox).toHaveBeenCalledOnce()
    expect(harness.dialog.showMessageBox.mock.calls[0]![0].detail).toContain('document missing')
    expect(harness.hosts).toHaveLength(0)
  })

  it.each([0, 1, 2])('waits for Host exit before recovery action %s', async (response) => {
    harness.dialog.showMessageBox.mockResolvedValue({ response, checkboxChecked: false })
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    const host = harness.hosts[0]!
    host.ready.resolve()
    await Promise.resolve(invoke(DESKTOP_IPC.boot))
    host.onFailure!(new Error('backend exited'))
    await host.stopping.promise
    expect(harness.app.relaunch).not.toHaveBeenCalled()
    expect(harness.disableAllPlugins).not.toHaveBeenCalled()
    host.exited.resolve()
    await harness.quitCompleted.promise
    expect(harness.app.relaunch).toHaveBeenCalledTimes(response === 0 ? 0 : 1)
    expect(harness.disableAllPlugins).toHaveBeenCalledTimes(response === 2 ? 1 : 0)
    if (response === 2) {
      expect(console.info).toHaveBeenCalledWith('Desktop profile recovery completed:', {
        profilePatchBackup: 'desktop-test-profile/cordis.patch.yml.bak-1789555200000', homePatch: 'unchanged',
      })
    } else {
      expect(console.info).not.toHaveBeenCalled()
    }
    expect(harness.dialog.showMessageBox).toHaveBeenCalledOnce()
    expect(harness.windows[0]!.urls).toEqual(['dsh-app://app/'])
  })

  it('shows the loading window before profile preparation and starts one actual Host', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    expect(harness.windows).toHaveLength(1)
    const window = harness.windows[0]!
    expect(window.options.show).toBe(true)
    expect(window.urls).toEqual(['dsh-app://app/'])
    expect(harness.hosts).toHaveLength(0)
    const retry = invoke(DESKTOP_IPC.boot)
    const secondRetry = invoke(DESKTOP_IPC.boot)
    harness.prepared.resolve()
    await harness.hostStarted.promise
    expect(harness.hosts).toHaveLength(1)
    expect(window.urls).toEqual(['dsh-app://app/'])
    harness.hosts[0]!.ready.resolve()
    await Promise.all([retry, secondRetry, harness.navigated.promise])
    expect(harness.applyRelease).toHaveBeenCalledTimes(1)
    expect(harness.hosts[0]).toMatchObject({
      node: process.execPath,
      runtime: join(harness.app.getAppPath(), 'dsh'),
      primaryRuntime: join('desktop-test-resources', 'runtime', 'primary-runtime'),
      profileResolution: 'runtime',
      profile: 'desktop-test-profile',
    })
    expect(harness.hosts[0]!.environment).toBe(process.env)
    expect(harness.hosts[0]!.start).toHaveBeenCalledTimes(1)
    expect(harness.windows).toHaveLength(1)
    expect(window.urls).toEqual(['dsh-app://app/'])
  })

  it('prepares an independent plugin profile for the unpackaged Host', async () => {
    harness.app.isPackaged = false
    vi.stubEnv('DSH_DESKTOP_DSH_DIR', undefined)
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    const project = join(harness.app.getAppPath(), '.desktop-build', 'development', 'project')
    expect(harness.hosts[0]).toMatchObject({ node: process.execPath, runtime: project, profile: 'desktop-test-profile' })
    expect(harness.applyRelease).toHaveBeenCalledOnce()
    harness.hosts[0]!.ready.resolve()
    await harness.navigated.promise
    expect(harness.dialog.showErrorBox).not.toHaveBeenCalled()
  })

  it('keeps startup errors in the existing window without a shell retry handler', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    const first = harness.hosts[0]!
    first.exited.resolve()
    first.ready.reject(new Error('plugin composition failed'))
    await harness.dialogShown.promise
    expect(harness.windows[0]!.urls).toEqual(['dsh-app://app/'])
    expect(harness.dialog.showMessageBox).toHaveBeenCalledOnce()
    expect(harness.handlers.has('dsh-desktop:backend-retry')).toBe(false)
    expect(harness.hosts).toHaveLength(1)
  })

  it('waits for a pending child to exit on quit without late window navigation', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    const window = harness.windows[0]!
    const host = harness.hosts[0]!
    host.stop.mockImplementation(() => { host.stopping.resolve(); return host.exited.promise })
    window.close()
    harness.app.quit()
    await host.stopping.promise
    expect(harness.app.quit).toHaveBeenCalledTimes(1)
    host.ready.resolve()
    host.exited.resolve()
    await harness.quitCompleted.promise
    expect(host.stop).toHaveBeenCalledTimes(1)
    expect(window.urls).toEqual(['dsh-app://app/'])
    expect(harness.windows).toHaveLength(1)
  })
})
