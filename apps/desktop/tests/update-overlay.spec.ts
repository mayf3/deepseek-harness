import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron'
import { createUpdateOverlay } from '../src/update-overlay.ts'

const native = vi.hoisted(() => ({ create: vi.fn<(options: BrowserWindowConstructorOptions) => object>() }))
vi.mock('electron', () => ({ BrowserWindow: function (options: object) { return native.create(options) } }))

afterEach(() => { vi.restoreAllMocks() })

function visibilityFixture(visible = true) {
  const parent = Object.assign(new EventEmitter(), {
    visible,
    getContentBounds: () => ({ x: 0, y: 0, width: 1000, height: 700 }),
    webContents: Object.assign(new EventEmitter(), { insertCSS: vi.fn(async () => 'blur'), removeInsertedCSS: vi.fn(async () => {}) }),
    isDestroyed: (): boolean => false,
    isVisible: () => parent.visible,
  })
  const window = Object.assign(new EventEmitter(), {
    destroyed: false,
    webContents: { setWindowOpenHandler: vi.fn() }, show: vi.fn(), focus: vi.fn(),
    setMenu: vi.fn(), setBounds: vi.fn(), isDestroyed: () => window.destroyed,
  })
  native.create.mockReturnValue(window)
  createUpdateOverlay(parent as unknown as BrowserWindow, 'owned', 'Update required', false)
  return { parent, window }
}

it('restores a ready overlay each time its parent is shown and releases visibility ownership on close', async () => {
  const { parent, window } = visibilityFixture()
  window.emit('ready-to-show')
  expect(window.show).toHaveBeenCalledOnce()
  for (let index = 0; index < 2; index++) {
    parent.visible = false
    parent.emit('hide')
    parent.visible = true
    parent.emit('show')
    await Promise.resolve()
  }
  expect(window.show).toHaveBeenCalledTimes(3)
  await Promise.resolve()
  expect(parent.webContents.removeInsertedCSS).not.toHaveBeenCalled()
  window.destroyed = true
  window.emit('closed')
  expect(parent.listenerCount('show')).toBe(0)
  expect(parent.webContents.removeInsertedCSS).toHaveBeenCalledWith('blur')
  parent.emit('show')
  expect(window.show).toHaveBeenCalledTimes(3)
})

it('waits for both a visible parent and a ready document, in either order', async () => {
  for (const readyFirst of [true, false]) {
    const { parent, window } = visibilityFixture(false)
    if (readyFirst) window.emit('ready-to-show')
    else { parent.visible = true; parent.emit('show') }
    expect(window.show).not.toHaveBeenCalled()
    if (readyFirst) { parent.visible = true; parent.emit('show') }
    else window.emit('ready-to-show')
    await Promise.resolve()
    expect(window.show).toHaveBeenCalledOnce()
    window.destroyed = true
    window.emit('closed')
  }
})

it('does not show or retain blur when closed before its document and CSS insertion settle', async () => {
  const { parent, window } = visibilityFixture(false)
  window.destroyed = true
  window.emit('closed')
  window.emit('ready-to-show')
  parent.visible = true
  parent.emit('show')
  await Promise.resolve()
  expect(window.show).not.toHaveBeenCalled()
  expect(parent.listenerCount('show')).toBe(0)
  expect(parent.webContents.removeInsertedCSS).toHaveBeenCalledWith('blur')
})

it('releases a macOS overlay after its parent has already been destroyed', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  const { parent, window } = visibilityFixture()
  await Promise.resolve()
  vi.spyOn(parent, 'isDestroyed').mockReturnValue(true)
  Object.defineProperty(parent, 'webContents', { get() { throw new Error('Object has been destroyed') } })
  window.destroyed = true
  expect(() => window.emit('closed')).not.toThrow()
  for (const event of ['focus', 'move', 'resize', 'show']) expect(parent.listenerCount(event)).toBe(0)
})

it('keeps the macOS mandatory overlay stationary and blocks parent keyboard input until close', () => {
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  try {
    const { parent, window } = visibilityFixture()
    expect(native.create).toHaveBeenLastCalledWith(expect.objectContaining({ modal: false, transparent: true, frame: false }))
    const event = { preventDefault: vi.fn() }
    parent.webContents.emit('before-input-event', event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
    window.emit('closed')
    expect(parent.listenerCount('focus')).toBe(0)
    expect(parent.webContents.listenerCount('before-input-event')).toBe(0)
  } finally { platform.mockRestore() }
})
