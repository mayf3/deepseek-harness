import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { installDevToolsShortcut } from '../src/devtools-shortcut.ts'

vi.mock('electron', () => ({ BrowserWindow: vi.fn() }))
afterEach(() => { vi.unstubAllGlobals() })

function renderer() {
  const contents = Object.assign(new EventEmitter(), { openDevTools: vi.fn() })
  installDevToolsShortcut(contents)
  return contents
}

it('opens DevTools only on an unmodified F12 keydown', () => {
  const contents = renderer()
  expect(contents.openDevTools).not.toHaveBeenCalled()
  const event = { preventDefault: vi.fn() }
  for (const input of [
    { type: 'keyUp', key: 'F12' },
    { type: 'keyDown', key: 'F11' },
    { type: 'keyDown', key: 'F12', isAutoRepeat: true },
    ...['meta', 'alt', 'control', 'shift'].map(modifier => ({ type: 'keyDown', key: 'F12', [modifier]: true })),
  ]) contents.emit('before-input-event', event, input)
  expect(contents.openDevTools).not.toHaveBeenCalled()
  expect(event.preventDefault).not.toHaveBeenCalled()
  contents.emit('before-input-event', event, { type: 'keyDown', key: 'F12', isAutoRepeat: false })
  expect(event.preventDefault).toHaveBeenCalledOnce()
  expect(contents.openDevTools).toHaveBeenCalledExactlyOnceWith({ mode: 'detach' })
})

it.each(['darwin', 'win32'])('handles Command+Option+I only on macOS (platform=%s)', (platform) => {
  vi.stubGlobal('process', { ...process, platform })
  const contents = renderer()
  const event = { preventDefault: vi.fn() }
  const input = { type: 'keyDown', key: 'ˆ', code: 'KeyI', meta: true, alt: true,
    control: false, shift: false, isAutoRepeat: false }
  for (const change of [
    { type: 'keyUp' }, { isAutoRepeat: true }, { code: 'KeyJ' },
    { meta: false }, { alt: false }, { control: true }, { shift: true },
  ]) contents.emit('before-input-event', event, { ...input, ...change })
  expect(contents.openDevTools).not.toHaveBeenCalled()
  expect(event.preventDefault).not.toHaveBeenCalled()
  contents.emit('before-input-event', event, input)
  if (platform === 'darwin') {
    expect(contents.openDevTools).toHaveBeenCalledExactlyOnceWith({ mode: 'detach' })
    expect(event.preventDefault).toHaveBeenCalledOnce()
  } else {
    expect(contents.openDevTools).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
  }
})
