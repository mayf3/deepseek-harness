/** Product-window preference IPC and native menu interception during physical-key dispatch/recording. */
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent, type Input, type MenuItemConstructorOptions } from 'electron'
import { bindingKey, effectiveShortcuts, presentBinding, parseShortcutDefinitions, parseShortcutEdit } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import type { NormalizedBinding, ShortcutConfigSnapshot, ShortcutDefinition, ShortcutPlatform, ShortcutRevision } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import { desktopKeybindings } from './keybindings.ts'
import { DESKTOP_IPC, assertDesktopSender } from './ipc.ts'

/**
 * Install application-owned configuration handlers and attach each product window's input lifecycle.
 * @param getWindow - current product window.
 * @param userData - Electron-resolved device preference directory.
 * @param platform - local device platform.
 * @param updateMenu - rebuild the application menu from current accepted bindings.
 * @returns window attachment and application teardown operations.
 */
export function installDesktopShortcuts(
  getWindow: () => BrowserWindow | undefined, userData: string, platform: ShortcutPlatform, updateMenu: () => void,
): {
  fileMenu(labels: { fileMenu: string; closePage: string }): MenuItemConstructorOptions
  attach(window: BrowserWindow): void
  dispose(): void
} {
  let definitions: readonly ShortcutDefinition[] = []
  let recording = false
  let revision: ShortcutRevision | undefined
  let closeBinding: NormalizedBinding | null = null
  const scopedDesktop = platform === 'windows' || platform === 'macos'
  const disposers = new Set<() => void>()
  const embeddedCommands = new Set(['page.close', 'page.refresh', 'pane.split', 'pane.fullscreen.toggle',
    'sidebar.right.toggle', 'sidebar.left.toggle', 'workspace.files', 'terminal.new', 'shortcuts.open', 'settings.open'])
  let embeddedKeys = new Set<string>()
  const sendMenuClose = (): void => {
    const window = getWindow()
    if (window === undefined || window.isDestroyed() || !window.isFocused() || !window.isEnabled()
      || revision === undefined || recording) return
    window.webContents.send(DESKTOP_IPC.shortcutsInput, { kind: 'menu', commandId: 'page.close', revision })
  }
  let keys = new Set<string>()
  const publish = (snapshot: ShortcutConfigSnapshot): void => {
    revision = definitions.length === 0 || snapshot.status === 'loading' ? undefined : snapshot.revision
    const rows = snapshot.status === 'loading' ? [] : effectiveShortcuts(definitions, snapshot.document, 'desktop', platform)
    keys = new Set(rows.flatMap(row => row.binding !== null && row.issue === null && row.conflicts.length === 0
      ? [bindingKey(row.binding)] : []))
    embeddedKeys = new Set(rows.flatMap(row => row.binding !== null && row.issue === null
      && row.conflicts.length === 0 && embeddedCommands.has(row.id)
      ? [bindingKey(row.binding)] : []))
    const close = rows.find(row => row.id === 'page.close')
    closeBinding = close?.issue === null && close.conflicts.length === 0 ? close.binding : null
    updateMenu()
    const window = getWindow()
    if (window !== undefined && !window.isDestroyed() && window.webContents.mainFrame.url.startsWith('dsh-app://app/')) {
      window.webContents.send(DESKTOP_IPC.shortcutsChanged, snapshot)
    }
  }
  const persistence = desktopKeybindings(userData, platform, publish)
  const assertSender = (event: IpcMainInvokeEvent): BrowserWindow => {
    const window = getWindow()
    if (window === undefined || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame) throw new Error('desktop shortcuts: rejected sender')
    assertDesktopSender(event, ['app'])
    return window
  }
  ipcMain.handle(DESKTOP_IPC.shortcutsGet, async (event, input: unknown) => {
    assertSender(event)
    definitions = parseShortcutDefinitions(input)
    persistence.setDefinitions(definitions)
    return persistence.reload()
  })
  ipcMain.handle(DESKTOP_IPC.shortcutsReload, async (event) => { assertSender(event); return persistence.reload() })
  ipcMain.handle(DESKTOP_IPC.shortcutsEdit, async (event, input: unknown, revision: unknown) => {
    assertSender(event)
    if (typeof revision !== 'string') throw new Error('desktop shortcuts: invalid revision')
    return persistence.edit(parseShortcutEdit(input), revision as ShortcutRevision)
  })
  ipcMain.handle(DESKTOP_IPC.shortcutsRecording, (event, active: unknown) => {
    const window = assertSender(event)
    if (typeof active !== 'boolean') throw new Error('desktop shortcuts: invalid recording state')
    recording = active
    window.webContents.setIgnoreMenuShortcuts(active)
  })
  ipcMain.handle(DESKTOP_IPC.shortcutsCloseWindow, (event, expected: unknown) => {
    const window = assertSender(event)
    if (expected !== revision || revision === undefined || recording || !window.isFocused() || !window.isEnabled()) return
    window.close()
  })
  return {
    fileMenu: (labels) => {
      const accelerator = presentBinding(closeBinding, platform).aria?.replace('Meta+', 'Command+')
      return { label: labels.fileMenu, submenu: [{
        id: 'dsh-page-close', label: labels.closePage, enabled: revision !== undefined,
        ...accelerator === undefined ? {} : { accelerator },
        click: sendMenuClose,
      }] }
    },
    attach(window) {
      const contents = window.webContents
      let deadKey = false
      const held = new Set<string>()
      const consumed = new Map<string, 'press' | 'repeat'>()
      let inputFrame: typeof contents.focusedFrame = null
      let inputRevision: ShortcutRevision | undefined
      const clear = (): void => {
        definitions = []; keys.clear(); embeddedKeys.clear(); held.clear(); consumed.clear()
        inputFrame = null; recording = false; deadKey = false; revision = undefined; closeBinding = null
        persistence.setDefinitions(null)
        updateMenu()
        if (!contents.isDestroyed()) contents.setIgnoreMenuShortcuts(false)
      }
      const navigation = (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>): void => {
        if (event.isMainFrame && !event.isSameDocument) clear()
      }
      const blur = (): void => {
        deadKey = false; held.clear(); consumed.clear(); inputFrame = null; contents.setIgnoreMenuShortcuts(false)
      }
      const beforeInput = (event: Electron.Event, input: Input): void => {
        if (!window.isFocused() || !window.isEnabled() || revision === undefined) {
          contents.setIgnoreMenuShortcuts(false)
          held.clear()
          consumed.clear()
          return
        }
        const modifiers = (['control', 'alt', 'shift', 'meta'] as const).filter(modifier => input[modifier])
        const key = bindingKey({ code: input.code, modifiers })
        const match = keys.has(key)
        const menuMatch = closeBinding !== null && closeBinding.secondCode === undefined && modifiers.join('+') === closeBinding.modifiers.join('+')
          && input.key.toUpperCase() === (closeBinding.code.startsWith('Key') ? closeBinding.code.slice(3) : input.code === closeBinding.code ? input.key.toUpperCase() : '')
        contents.setIgnoreMenuShortcuts(recording || match || menuMatch)
        const frame = contents.focusedFrame
        const composing = input.isComposing || input.key === 'Dead' || deadKey || input.modifiers.includes('altgr')
        if (input.type === 'keyDown') deadKey = input.key === 'Dead'
        if (recording || composing || frame === null) { held.clear(); consumed.clear(); return }
        let binding: NormalizedBinding = { code: input.code, modifiers }
        let priority = false
        if (scopedDesktop) {
          if (frame !== inputFrame || inputRevision !== revision) { held.clear(); inputFrame = frame; inputRevision = revision }
          const modifierKey = /^(Control|Alt|Shift|Meta)(Left|Right)$/u.test(input.code)
          if (input.type === 'keyUp') {
            // A chord's first key reached the renderer, so its release must reach the same input handlers.
            if (consumed.get(input.code) === 'press') event.preventDefault()
            consumed.delete(input.code)
            held.delete(input.code)
            if (modifierKey) held.clear()
            return
          }
          if (!input.isAutoRepeat) consumed.delete(input.code)
          if (modifierKey) { held.clear(); return }
          if (input.isAutoRepeat && consumed.has(input.code) && !match) { event.preventDefault(); return }
          if (input.isAutoRepeat && !held.has(input.code) && !match) return
          held.add(input.code)
          const codes: [string, ...string[]] = [input.code, ...[...held].filter(value => value !== input.code)]
          codes.sort()
          const pair = { code: codes[0], ...(codes[1] === undefined ? {} : { secondCode: codes[1] }), modifiers }
          priority = keys.has(key)
          if (codes.length === 2 && keys.has(bindingKey(pair))) { binding = pair; priority = true }
        }
        const main = frame === contents.mainFrame
        if (!priority && (main || !embeddedKeys.has(key))) return
        event.preventDefault()
        if (input.type !== 'keyDown') return
        if (scopedDesktop) {
          if (!input.isAutoRepeat) {
            if (binding.secondCode !== undefined) {
              consumed.set(binding.code, 'repeat')
              consumed.set(binding.secondCode, 'repeat')
            }
            consumed.set(input.code, 'press')
          }
          // Electron can omit both keyups after interception; completed presses cannot seed another chord.
          held.clear()
        }
        let embedding = frame
        while (!main && embedding.parent !== null && embedding.parent !== contents.mainFrame) embedding = embedding.parent
        contents.send(DESKTOP_IPC.shortcutsInput, { kind: main ? 'keyboard' : 'iframe', revision, frameName: main ? '' : embedding.name,
          code: binding.code, ...(binding.secondCode === undefined ? {} : { secondCode: binding.secondCode }),
          repeat: input.isAutoRepeat, control: input.control, alt: input.alt, shift: input.shift, meta: input.meta })
      }
      const dispose = (): void => {
        contents.off('did-start-navigation', navigation)
        contents.off('before-input-event', beforeInput)
        window.off('blur', blur)
        window.off('closed', closed)
        disposers.delete(dispose)
        if (!contents.isDestroyed()) contents.setIgnoreMenuShortcuts(false)
      }
      const closed = (): void => { clear(); dispose() }
      contents.on('did-start-navigation', navigation)
      contents.on('before-input-event', beforeInput)
      window.on('closed', closed)
      window.on('blur', blur)
      disposers.add(dispose)
    },
    dispose() {
      for (const dispose of disposers) dispose()
      persistence.dispose()
      for (const channel of [DESKTOP_IPC.shortcutsGet, DESKTOP_IPC.shortcutsReload,
        DESKTOP_IPC.shortcutsEdit, DESKTOP_IPC.shortcutsRecording, DESKTOP_IPC.shortcutsCloseWindow]) {
        ipcMain.removeHandler(channel)
      }
    },
  }
}
