/** Main-document keyboard adapter; local controls arbitrate before window bubbling. */
import type { Shortcuts, ShortcutContext, ShortcutFixedInput } from './types.ts'
import type { ShortcutPlatform, ShortcutRuntime } from '../protocol.ts'

/**
 * Detect the visiting device, never the server operating system.
 * @param document - product document, marked by Electron preload when present.
 * @param navigator - browser device identification.
 * @returns explicit runtime and platform for default resolution.
 */
export function detectEnvironment(document: Document, navigator: Navigator): {
  runtime: ShortcutRuntime
  platform: ShortcutPlatform
} {
  const desktop = document.documentElement.dataset.platform
  const device = desktop ?? navigator.platform
  return { runtime: desktop === undefined ? 'web' : 'desktop',
    platform: /darwin|mac|iphone|ipad/iu.test(device) ? 'macos' : /win/iu.test(device) ? 'windows' : 'linux' }
}

/**
 * Install document composition tracking and application dispatch after local handlers.
 * @param window - input window owned by the client plugin.
 * @param shortcuts - command registry for this window.
 * @param fixed - optional fixed-sequence consumer after local controls.
 * @param native - native input owns configurable bindings; DOM delivery only feeds fixed actions.
 * @returns disposer releasing every listener.
 */
export function installKeyboard(window: Window, shortcuts: Pick<Shortcuts, 'dispatch' | 'runtime' | 'platform'> & Partial<Pick<Shortcuts, 'config'>>,
  fixed?: (input: ShortcutFixedInput) => void, native = false): () => void {
  const document = window.document
  let pending = false
  let pendingTimer: number | undefined
  const chords = !native && shortcuts.runtime === 'desktop' && (shortcuts.platform === 'macos' || shortcuts.platform === 'windows')
  const held = new Set<string>()
  const reset = (): void => { held.clear(); fixed?.({ type: 'reset' }) }
  const offConfig = chords ? shortcuts.config?.subscribe(reset) : undefined
  let composing = false
  let compositionEnded = false
  let deadKey = false
  const start = (): void => { composing = true; reset() }
  const end = (): void => { composing = false; compositionEnded = true; reset() }
  const release = (event: KeyboardEvent): void => {
    compositionEnded = false
    held.delete(event.code)
    // Command can suppress character keyup delivery on macOS.
    if (/^(Control|Alt|Shift|Meta)(Left|Right)$/u.test(event.code)) held.clear()
  }
  const blur = (): void => { composing = false; compositionEnded = false; deadKey = false; reset() }
  const modalSelector = '[role="dialog"][aria-modal="true"], [role="menu"]'
  const containsModal = (node: Node): boolean => node instanceof Element
    && (node.matches(modalSelector) || node.querySelector(modalSelector) !== null)
  const changedModals = (records: MutationRecord[]): void => {
    if (records.some(record => record.type === 'attributes'
      ? record.oldValue === 'dialog' || record.oldValue === 'true' || containsModal(record.target)
      : [...record.addedNodes, ...record.removedNodes].some(containsModal))) reset()
  }
  const observer = fixed === undefined && !chords ? undefined : new MutationObserver(changedModals)
  observer?.observe(document.documentElement, { childList: true, subtree: true,
    attributes: true, attributeFilter: ['role', 'aria-modal'], attributeOldValue: true })
  const capture = (): void => {
    if (pending) reset()
    window.clearTimeout(pendingTimer)
    if (observer !== undefined) changedModals(observer.takeRecords())
    pending = true
    // Native event listeners can yield a microtask checkpoint before bubbling.
    pendingTimer = window.setTimeout(() => {
      pending = false
      pendingTimer = undefined
      reset()
    }, 0)
  }
  const keydown = (event: KeyboardEvent): void => {
    window.clearTimeout(pendingTimer)
    pendingTimer = undefined
    pending = false
    const target = event.composedPath().find(value => value instanceof Element)
    const element = target instanceof Element ? target : document.activeElement
    const region = element?.closest('.xterm') ? 'terminal'
      : element?.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]') ? 'editable' : 'page'
    const dialogs = document.querySelectorAll<HTMLElement>(modalSelector)
    const top = [...dialogs].at(-1)
    const context: ShortcutContext = { region, modal: top === undefined ? null : top.dataset.shortcutModal ?? 'other', target: element }
    // oxlint-disable-next-line typescript/no-deprecated -- IME 229 covers engines without isComposing.
    const guarded = composing || compositionEnded || deadKey || event.isComposing || event.keyCode === 229
      || event.getModifierState('AltGraph')
    const isDead = event.key === 'Dead'
    // macOS can report Option+Command+N as Dead outside input-method composition.
    const commandDeadKey = isDead && shortcuts.runtime === 'web' && shortcuts.platform === 'macos'
      && event.code === 'KeyN' && event.metaKey && event.altKey && !event.ctrlKey && !event.shiftKey
    compositionEnded = false
    deadKey = isDead
    const gesture = { code: event.code, control: event.ctrlKey, alt: event.altKey, shift: event.shiftKey,
      meta: event.metaKey, repeat: event.repeat, composing: guarded || isDead, defaultPrevented: event.defaultPrevented }
    const consume = (): void => {
      event.preventDefault()
      if (commandDeadKey) deadKey = false
    }
    fixed?.({ type: 'keydown', gesture, context, consume })
    if (native) return
    let secondCode: string | undefined
    const code = event.code
    if (chords) {
      if (gesture.composing || event.defaultPrevented || /^(Control|Alt|Shift|Meta)(Left|Right)$/u.test(code)) {
        held.clear()
        return
      }
      // A repeated key after focus/composition reset cannot restore an abandoned chord.
      if (event.repeat && !held.has(code)) return
      held.add(code)
      if (held.size === 2) secondCode = [...held].find(value => value !== event.code)
    }
    shortcuts.dispatch({ ...gesture, composing: guarded || (isDead && !commandDeadKey),
      code, ...(secondCode === undefined ? {} : { secondCode }),
      defaultPrevented: event.defaultPrevented }, context, consume)
  }
  document.addEventListener('compositionstart', start, true)
  document.addEventListener('compositionend', end, true)
  document.addEventListener('focusin', reset, true)
  document.addEventListener('pointerdown', reset, true)
  window.addEventListener('keydown', capture, true)
  window.addEventListener('keydown', keydown)
  window.addEventListener('keyup', release, chords)
  window.addEventListener('blur', blur)
  return () => {
    pending = false
    offConfig?.()
    held.clear()
    window.clearTimeout(pendingTimer)
    observer?.disconnect()
    document.removeEventListener('compositionstart', start, true)
    document.removeEventListener('compositionend', end, true)
    document.removeEventListener('focusin', reset, true)
    document.removeEventListener('pointerdown', reset, true)
    window.removeEventListener('keydown', capture, true)
    window.removeEventListener('keydown', keydown)
    window.removeEventListener('keyup', release, chords)
    window.removeEventListener('blur', blur)
  }
}
