// @vitest-environment jsdom
/** Desktop chords use overlapping physical presses and preserve local input ownership. */
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'
import { installKeyboard } from '../src/client/dom.ts'
import { ShortcutRegistry } from '../src/client/registry.ts'
import { bindingIssue, bindingKey, effectiveShortcuts, normalizeBinding, parseBinding, parseShortcutDocument,
  parseShortcutDefinitions, presentBinding, ShortcutPersistence } from '../src/protocol.ts'
import type { ShortcutBinding, ShortcutCommandId, ShortcutPlatform, ShortcutRuntime } from '../src/protocol.ts'

const id = 'test.action' as ShortcutCommandId
const other = 'test.other' as ShortcutCommandId
const pair = { code: 'KeyA', secondCode: 'KeyB', modifiers: [] } as const
const definitions = [{ id, defaults: {} }, { id: other, defaults: {} }]
afterEach(() => { document.body.replaceChildren() })

function mount(binding: ShortcutBinding, platform: ShortcutPlatform = 'macos', runtime: ShortcutRuntime = 'desktop') {
  const registry = new ShortcutRegistry(runtime, platform)
  const run = vi.fn()
  registry.register({ id, defaults: {}, label: () => 'Action', aliases: [], regions: ['page', 'editable', 'terminal'],
    modals: ['settings'], resolve: () => ({ status: 'handled', run }) })
  registry.configure({ ...registry.config.getSnapshot(), revision: 'custom' as never,
    document: { schemaVersion: 2, profiles: { [`${runtime}:${platform}`]: { [id]: binding } } } })
  const off = installKeyboard(window, registry)
  onTestFinished(off)
  const down = (code: string, extra: KeyboardEventInit = {}, target: Element = document.body) => {
    const event = new KeyboardEvent('keydown', { code, key: code.replace('Key', ''), bubbles: true, cancelable: true, ...extra })
    target.dispatchEvent(event)
    return event.defaultPrevented
  }
  const up = (code: string) => { fireEvent.keyUp(document.body, { code }) }
  return { registry, run, down, up, off }
}

it.each(['macos', 'windows'] as const)('runs %s overlapping chords in either order, never sequential presses or repeats', (platform) => {
  const f = mount(pair, platform)
  expect(f.down('KeyA')).toBe(false)
  f.up('KeyA')
  expect(f.down('KeyB')).toBe(false)
  f.up('KeyB')
  expect(f.run).not.toHaveBeenCalled()
  expect(f.down('KeyB')).toBe(false)
  expect(f.down('KeyA')).toBe(true)
  expect(f.down('KeyB', { repeat: true })).toBe(true)
  expect(f.run).toHaveBeenCalledOnce()
  f.up('KeyA'); f.up('KeyB')
  f.down('KeyA'); expect(f.down('KeyB')).toBe(true)
  expect(f.run).toHaveBeenCalledTimes(2)
  f.off()
  f.up('KeyA'); f.up('KeyB'); f.down('KeyA'); f.down('KeyB')
  expect(f.run).toHaveBeenCalledTimes(2)
})

it.each(['macos', 'windows'] as const)('executes %s single keys and exact four-modifier chords', (platform) => {
  for (const code of ['KeyA', 'F1', 'ArrowLeft', 'Escape', 'Tab', 'Enter']) {
    const f = mount({ code, modifiers: [] }, platform)
    expect(f.down(code)).toBe(true)
    f.down(code, { repeat: true }); f.up(code)
    expect(f.run).toHaveBeenCalledOnce()
    f.off()
  }
  const f = mount({ ...pair, modifiers: ['control', 'alt', 'shift', 'meta'] }, platform)
  const keys = { ctrlKey: true, altKey: true, shiftKey: true, metaKey: true }
  f.down('KeyA', keys); expect(f.down('KeyB', keys)).toBe(true)
  expect(f.run).toHaveBeenCalledOnce()
  f.up('MetaLeft')
  expect(f.down('KeyB', { repeat: true })).toBe(false)
  expect(f.run).toHaveBeenCalledOnce()
})


it.each(['blur', 'focus', 'pointer', 'composition', 'modal', 'configuration', 'consumed', 'stopped'] as const)(
  'abandons partial chords after %s', (change) => {
    const f = mount(pair)
    f.down('KeyA')
    switch (change) {
      case 'blur': fireEvent.blur(window); break
      case 'focus': fireEvent.focusIn(document.body); break
      case 'pointer': fireEvent.pointerDown(document.body); break
      case 'composition': fireEvent.compositionStart(document.body); fireEvent.compositionEnd(document.body); break
      case 'modal': {
        const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true')
        document.body.append(dialog); dialog.remove(); break
      }
      case 'configuration': f.registry.configure({ ...f.registry.config.getSnapshot(), revision: 'next' as never }); break
      case 'consumed': {
        document.body.addEventListener('keydown', (event) => { event.preventDefault() }, { once: true })
        f.down('KeyX'); break
      }
      case 'stopped': {
        document.body.addEventListener('keydown', (event) => { event.stopPropagation() }, { once: true })
        f.down('KeyX'); break
      }
    }
    expect(f.down('KeyB')).toBe(false)
    expect(f.run).not.toHaveBeenCalled()
  })

it('does not form a two-key binding from three held ordinary keys', () => {
  const f = mount(pair)
  f.down('KeyC'); f.down('KeyA'); f.down('KeyB')
  expect(f.run).not.toHaveBeenCalled()
  f.up('KeyC'); f.down('KeyA', { repeat: true })
  expect(f.run).not.toHaveBeenCalled()
})

it.each([['web', 'macos'], ['web', 'windows'], ['web', 'linux'], ['desktop', 'linux']] as const)(
  'does not enable bare keys or chords in %s on %s', (runtime, platform) => {
    for (const binding of [pair, { code: 'KeyA', modifiers: [] }, { ...pair, modifiers: ['control', 'alt', 'shift', 'meta'] }] as const) {
      expect(bindingIssue(normalizeBinding(binding, platform), runtime, platform)).not.toBeNull()
      const f = mount(binding, platform, runtime)
      f.down('KeyA'); f.down('KeyB')
      expect(f.run).not.toHaveBeenCalled()
      f.off()
    }
  })

it('canonicalizes unordered pairs, rejects invalid main keys, and omits unsupported ARIA accelerators', () => {
  const reversed = normalizeBinding({ ...pair, code: 'KeyB', secondCode: 'KeyA' }, 'macos')
  expect(reversed).toEqual(pair)
  expect(bindingKey(reversed)).toBe('KeyA+KeyB')
  expect(presentBinding(reversed, 'macos')).toEqual({ keys: ['A', 'B'], aria: undefined })
  expect(presentBinding(reversed, 'windows')).toEqual({ keys: ['A', 'B'], aria: undefined })
  expect(presentBinding({ ...reversed, modifiers: ['control', 'shift'] }, 'windows').keys)
    .toEqual(['Ctrl', '+', 'Shift', '+', 'A', 'B'])
  for (const input of [
    { ...pair, secondCode: 'KeyA' }, { ...pair, secondCode: 'ShiftLeft' }, { ...pair, thirdCode: 'KeyC' },
    { ...pair, secondCode: ['KeyB', 'KeyC'] }, { code: 'MetaLeft', modifiers: ['control'] }, { modifiers: ['meta'] },
  ]) expect(() => parseBinding(input)).toThrow()
})

it.each(['macos', 'windows'] as const)('migrates %s preferences on write and rejects both directions of single/chord conflicts', async (platform) => {
  let raw = JSON.stringify({ schemaVersion: 1, profiles: { 'web:macos': { 'dormant.web': null } } })
  const original = raw
  const store = new ShortcutPersistence({ read: () => raw, write: (next) => { raw = next }, backup() {} }, 'desktop', platform, false, () => {})
  onTestFinished(() => { store.dispose() })
  store.setDefinitions(definitions)
  let state = await store.reload()
  expect(raw).toBe(original)
  const saved = await store.edit({ type: 'set', id, binding: pair }, state.revision)
  expect(saved.status).toBe('saved')
  expect(JSON.parse(raw)).toEqual({ schemaVersion: 2, profiles: { 'web:macos': { 'dormant.web': null }, [`desktop:${platform}`]: { [id]: pair } } })
  expect(parseShortcutDocument(raw)).toEqual(saved.snapshot.document)
  expect(parseShortcutDocument(raw.replace('"schemaVersion": 2', '"schemaVersion": 1'))).toBe('invalid')
  state = saved.snapshot
  for (const code of ['KeyA', 'KeyB']) {
    const rejected = await store.edit({ type: 'set', id: other, binding: { code, modifiers: [] } }, state.revision)
    expect(rejected).toMatchObject({ status: 'conflict', conflicts: [id] })
  }
  const cleared = await store.edit({ type: 'reset-all' }, state.revision)
  const single = await store.edit({ type: 'set', id, binding: { code: 'KeyB', modifiers: [] } }, cleared.snapshot.revision)
  expect((await store.edit({ type: 'set', id: other, binding: pair }, single.snapshot.revision)).status).toBe('conflict')
  const overlapping = { schemaVersion: 2 as const, profiles: { [`desktop:${platform}`]: { [id]: pair, [other]: { code: 'KeyA', modifiers: [] } } } }
  expect(effectiveShortcuts(definitions, overlapping, 'desktop', platform).map(row => row.conflicts)).toEqual([[other], [id]])
})

it.each(['macos', 'windows'] as const)('rejects direct %s writes that overlap fixed actions and disables previously saved conflicts', async (platform) => {
  const fixedId = 'menu.dismiss' as ShortcutCommandId
  const catalog = parseShortcutDefinitions([...definitions,
    { id: fixedId, defaults: {}, fixed: [{ code: 'Escape', modifiers: [] }] }])
  const storage = { read: () => null, write: vi.fn(), backup() {} }
  const store = new ShortcutPersistence(storage, 'desktop', platform, false, () => {})
  onTestFinished(() => { store.dispose() })
  store.setDefinitions(catalog)
  const state = await store.reload()
  for (const binding of [{ code: 'Escape', modifiers: [] }, { code: 'KeyA', secondCode: 'Escape', modifiers: [] }] as const) {
    expect(await store.edit({ type: 'set', id, binding }, state.revision)).toMatchObject({ status: 'conflict', conflicts: [fixedId] })
    expect(effectiveShortcuts(catalog, { schemaVersion: 2, profiles: { [`desktop:${platform}`]: { [id]: binding } } },
      'desktop', platform).find(row => row.id === id)?.conflicts).toEqual([fixedId])
  }
  expect(storage.write).not.toHaveBeenCalled()
  expect((await store.edit({ type: 'set', id: fixedId, binding: null }, state.revision)).status).toBe('not-ready')
  expect((await store.edit({ type: 'set', id, binding: { code: 'Escape', modifiers: ['control', 'alt'] } }, state.revision)).status).toBe('saved')
  store.setDefinitions(definitions)
  expect((await store.edit({ type: 'set', id, binding: { code: 'Escape', modifiers: [] } }, (await store.reload()).revision)).status).toBe('saved')
})

it('rejects malformed fixed reservations at catalog IPC ingress', () => {
  for (const fixed of [[], null, [null], [{ code: 'MetaLeft', modifiers: [] }], [{ code: 'Escape', modifiers: [], extra: true }]]) {
    expect(() => parseShortcutDefinitions([{ id, defaults: {}, fixed }])).toThrow()
  }
  expect(() => parseShortcutDefinitions([{ id, defaults: { desktop: pair }, fixed: [{ code: 'Escape', modifiers: [] }] }])).toThrow()
})
