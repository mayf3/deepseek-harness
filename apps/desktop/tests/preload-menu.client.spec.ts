// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installWindowsMenu } from '../src/preload-menu.ts'
import { DESKTOP_IPC } from '../src/ipc.ts'

const invoke = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<void>>())
vi.mock('electron', () => ({ ipcRenderer: { invoke } }))
let menu: ReturnType<typeof installWindowsMenu> | undefined

beforeEach(() => {
  document.documentElement.lang = 'en'
  invoke.mockResolvedValue(undefined)
})
afterEach(() => {
  menu?.dispose()
  menu = undefined
  document.body.replaceChildren()
  document.documentElement.lang = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

it('localizes caption entries and removes the menu on disposal', () => {
  menu = installWindowsMenu()
  const host = document.querySelector('[data-windows-menu]')!
  const bar = host.shadowRoot!.querySelector('[role=menubar]')!
  expect(bar.outerHTML).toMatchSnapshot('english')
  document.documentElement.lang = 'zh-CN'
  menu.update()
  expect(bar.outerHTML).toMatchSnapshot('chinese')
  menu.dispose()
  menu = undefined
  expect(document.querySelector('[data-windows-menu]')).toBeNull()
})

it('opens native menus without stealing pointer focus and resets popup state when closed', async () => {
  let close!: () => void
  invoke.mockImplementation(() => new Promise<void>((resolve) => { close = resolve }))
  menu = installWindowsMenu()
  const button = document.querySelector('[data-windows-menu]')!.shadowRoot!.querySelector('button')!
  vi.spyOn(button, 'getBoundingClientRect').mockReturnValue(new DOMRect(48, 6, 90, 28))
  const pointer = new MouseEvent('pointerdown', { cancelable: true })
  button.dispatchEvent(pointer)
  expect(pointer.defaultPrevented).toBe(true)
  const mouse = new MouseEvent('mousedown', { cancelable: true })
  button.dispatchEvent(mouse)
  expect(mouse.defaultPrevented).toBe(true)
  button.click()
  expect(invoke).toHaveBeenCalledExactlyOnceWith(DESKTOP_IPC.windowsMenu, 'application', 48, 34)
  expect(button.getAttribute('aria-expanded')).toBe('true')
  close()
  await vi.waitFor(() => { expect(button.getAttribute('aria-expanded')).toBe('false') })
})

it('moves between menu entries with arrow keys and opens the focused entry with ArrowDown', () => {
  menu = installWindowsMenu()
  const buttons = document.querySelector('[data-windows-menu]')!.shadowRoot!.querySelectorAll('button')
  buttons[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true }))
  expect(buttons[0]!.tabIndex).toBe(-1)
  expect(buttons[1]!.tabIndex).toBe(0)
  buttons[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }))
  expect(invoke).toHaveBeenCalledWith(DESKTOP_IPC.windowsMenu, 'edit', 0, 0)
})
