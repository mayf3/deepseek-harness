import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron'
import { installDevToolsShortcut } from '../src/devtools-shortcut.ts'
import { createUpdateOverlay, hasUpdateOverlay } from '../src/update-overlay.ts'

const native = vi.hoisted(() => ({ create: vi.fn<(options: BrowserWindowConstructorOptions) => object>() }))
vi.mock('electron', () => ({ BrowserWindow: function (options: object) { return native.create(options) } }))

it('keeps the macOS mandatory overlay stationary and blocks parent keyboard input until close', () => {
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  const parent = Object.assign(new EventEmitter(), {
    getContentBounds: () => ({ x: 0, y: 0, width: 1000, height: 700 }),
    webContents: Object.assign(new EventEmitter(), { insertCSS: vi.fn(async () => 'blur'), removeInsertedCSS: vi.fn(async () => {}), openDevTools: vi.fn() }),
    isDestroyed: () => false,
  })
  const window = Object.assign(new EventEmitter(), {
    webContents: { setWindowOpenHandler: vi.fn() }, show: vi.fn(), focus: vi.fn(),
    setMenu: vi.fn(), setBounds: vi.fn(), isDestroyed: () => false,
  })
  native.create.mockReturnValue(window)
  try {
    installDevToolsShortcut(parent.webContents)
    createUpdateOverlay(parent as unknown as BrowserWindow, 'owned', 'Update required', false)
    expect(native.create).toHaveBeenLastCalledWith(expect.objectContaining({ modal: false, transparent: true, frame: false }))
    const event = { preventDefault: vi.fn() }
    expect(hasUpdateOverlay(parent.webContents)).toBe(true)
    parent.webContents.emit('before-input-event', event, { type: 'keyDown', key: 'F12' })
    expect(parent.webContents.openDevTools).not.toHaveBeenCalled()
    parent.webContents.emit('before-input-event', { preventDefault: vi.fn() },
      { type: 'keyDown', code: 'KeyI', meta: true, alt: true })
    expect(parent.webContents.openDevTools).not.toHaveBeenCalled()
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledTimes(2)
    window.emit('closed')
    expect(parent.listenerCount('focus')).toBe(0)
    expect(parent.webContents.listenerCount('before-input-event')).toBe(1)
    expect(hasUpdateOverlay(parent.webContents)).toBe(false)
    parent.webContents.emit('before-input-event', event, { type: 'keyDown', key: 'F12' })
    expect(parent.webContents.openDevTools).toHaveBeenCalledExactlyOnceWith({ mode: 'detach' })
  } finally { platform.mockRestore() }
})
