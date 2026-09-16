import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainEvent } from 'electron'
import { DesktopPlatformView, platformBounds } from '../src/platform-view.ts'

const state = vi.hoisted(() => ({ views: [] as unknown[], sessions: [] as unknown[], openExternal: vi.fn(async () => {}) }))
vi.mock('electron', () => ({
  shell: { openExternal: state.openExternal },
  session: { fromPartition: vi.fn((partition: string) => {
    const value = {
      partition, setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(),
      clearStorageData: vi.fn(async () => {}),
    }
    state.sessions.push(value)
    return value
  }) },
  WebContentsView: class {
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: 'https://platform.deepseek.com/usage' },
      session: { clearStorageData: vi.fn(async () => {}) },
      setWindowOpenHandler: vi.fn(), loadURL: vi.fn(async (_url: string) => {}),
      isDestroyed: () => false, close: vi.fn(),
    })
    setBounds = vi.fn()
    constructor() { state.views.push(this) }
  },
}))

afterEach(() => { state.views.length = 0; state.sessions.length = 0; vi.clearAllMocks() })
function setup() {
  const owner = { contentView: { addChildView: vi.fn(), removeChildView: vi.fn() }, isDestroyed: () => false } as unknown as BrowserWindow
  const manager = new DesktopPlatformView('/bundled/preload.cjs')
  manager.setSession({ origin: 'https://platform.deepseek.com', token: 'fixture-secret' })
  return { manager, owner }
}
function view() {
  return state.views.at(-1) as { webContents: EventEmitter & {
    mainFrame: { url: string }
    loadURL: ReturnType<typeof vi.fn>
    setWindowOpenHandler: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
  } }
}
const bounds = { x: 10, y: 20, width: 800, height: 600 }

it('bootstraps only the owned main frame and never puts the token in a URL', async () => {
  const { manager, owner } = setup()
  await manager.open(owner, 'usage', bounds)
  const sender = view().webContents
  const event = { sender, senderFrame: sender.mainFrame } as unknown as IpcMainEvent
  expect(manager.bootstrap(event)).toEqual({ origin: 'https://platform.deepseek.com', token: 'fixture-secret' })
  expect(sender.loadURL).toHaveBeenCalledWith('https://platform.deepseek.com/usage')
  expect(() => manager.bootstrap({ ...event, senderFrame: { url: sender.mainFrame.url } } as IpcMainEvent)).toThrow()
  expect(() => manager.bootstrap({ ...event, sender: {} } as IpcMainEvent)).toThrow()
  sender.mainFrame.url = 'https://other.example/usage'
  expect(() => manager.bootstrap(event)).toThrow()
  manager.close()
})

it('destroys old documents on sign-out or credential replacement', async () => {
  const { manager, owner } = setup()
  await manager.open(owner, 'usage', bounds)
  const first = view().webContents
  manager.setSession({ origin: 'https://platform.deepseek.com', token: 'replacement' })
  expect(first.close).toHaveBeenCalledOnce()
  expect(() => manager.bootstrap({ sender: first, senderFrame: first.mainFrame } as unknown as IpcMainEvent)).toThrow()
  await manager.open(owner, 'top-up', bounds)
  expect(view().webContents.loadURL).toHaveBeenCalledWith('https://platform.deepseek.com/top_up')
  const second = view().webContents
  manager.setSession(null)
  expect(second.close).toHaveBeenCalledOnce()
  await expect(manager.open(owner, 'usage', bounds)).rejects.toThrow()
})

it('blocks cross-origin navigation and redirects', async () => {
  const { manager, owner } = setup()
  await manager.open(owner, 'usage', bounds)
  for (const name of ['will-navigate', 'will-redirect']) {
    const event = { preventDefault: vi.fn() }
    view().webContents.emit(name, event, 'https://platform.deepseek.com.evil/usage')
    expect(event.preventDefault).toHaveBeenCalledOnce()
    event.preventDefault.mockClear()
    view().webContents.emit(name, event, 'https://platform.deepseek.com/top_up')
    expect(event.preventDefault).not.toHaveBeenCalled()
  }
  manager.close()
})

it.each([null, {}, { ...bounds, width: NaN }, { ...bounds, x: -1 }, { ...bounds, y: Infinity }])('rejects malformed IPC rectangles', (value) => {
  expect(() => platformBounds(value)).toThrow()
})


it('opens HTTPS payment links in the system browser without an embedded child window', async () => {
  const { manager, owner } = setup()
  await manager.open(owner, 'top-up', bounds)
  const handler = view().webContents.setWindowOpenHandler.mock.calls[0]![0] as (details: { url: string }) => { action: string }
  expect(handler({ url: 'https://payment.example/order' })).toEqual({ action: 'deny' })
  expect(state.openExternal).toHaveBeenCalledWith('https://payment.example/order')
  vi.mocked(state.openExternal).mockClear()
  for (const url of ['file:///tmp/test', 'javascript:alert(1)', 'https://user:pass@payment.example/order']) {
    expect(handler({ url })).toEqual({ action: 'deny' })
  }
  expect(state.openExternal).not.toHaveBeenCalled()
  manager.close()
})
