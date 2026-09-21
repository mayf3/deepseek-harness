import { describe, expect, it } from 'vitest'
import { bindingIssue, editShortcutDocument, effectiveShortcuts, normalizeBinding, parseBinding, parseShortcutDefinitions,
  parseShortcutDocument, parseShortcutEdit } from '../src/protocol.ts'
import type { ShortcutCommandId, ShortcutDefinition, ShortcutDocument } from '../src/protocol.ts'

const id = (value: string) => value as ShortcutCommandId
const primary = (code: string) => ({ code, modifiers: ['primary'] as const })
const definitions: readonly ShortcutDefinition[] = [
  { id: id('test.one'), defaults: { desktop: primary('KeyB') } },
  { id: id('test.two'), defaults: { desktop: primary('KeyJ') } },
]

describe('preference document validation and conflict resolution', () => {
  it('distinguishes inherited, cleared, reset, and dormant preferences without touching other profiles', () => {
    const document: ShortcutDocument = { schemaVersion: 1, profiles: {
      'desktop:macos': { 'dormant.command': primary('KeyU'), 'test.one': null },
      'web:windows': { 'test.one': primary('Slash') },
    } }
    expect(parseShortcutDocument(JSON.stringify(document))).toEqual(document)
    expect(effectiveShortcuts(definitions, document, 'desktop', 'macos')[0]).toMatchObject({ modified: true, binding: null })
    const reset = editShortcutDocument(document, { type: 'reset', id: id('test.one') }, 'desktop', 'macos')
    expect(reset.profiles['desktop:macos']).toEqual({ 'dormant.command': primary('KeyU') })
    expect(effectiveShortcuts(definitions, reset, 'desktop', 'macos')[0]).toMatchObject({ modified: false, binding: { code: 'KeyB' } })
    expect(editShortcutDocument(document, { type: 'reset-all' }, 'desktop', 'macos').profiles)
      .toEqual({ 'desktop:macos': {}, 'web:windows': document.profiles['web:windows'] })
  })

  it.each(['{', 'null', '[]', '{"schemaVersion":0,"profiles":{}}', '{"schemaVersion":1,"profiles":{"alien":{}}}',
    '{"schemaVersion":1,"profiles":{"web:macos":{"bad":null}}}', '{"schemaVersion":1,"profiles":{},"extra":1}',
    '{"schemaVersion":1,"profiles":{"web:macos":{"test.one":{"code":"KeyB","modifiers":["bogus"]}}}}'])('retains invalid documents: %s', (raw) => {
    expect(parseShortcutDocument(raw)).toBe('invalid')
  })
  it('refuses future versions without interpreting their fields', () => {
    expect(parseShortcutDocument('{"schemaVersion":3,"profiles":17}')).toBe('future')
    expect(parseShortcutDocument(null)).toEqual({ schemaVersion: 1, profiles: {} })
    expect(() => parseBinding({ code: 'KeyB', modifiers: ['primary'], extra: true })).toThrow()
    expect(() => parseBinding({ code: 'Unknown', modifiers: [] })).toThrow()
  })

  it('lets explicit overrides displace new defaults, but disables both conflicting explicit overrides', () => {
    const document: ShortcutDocument = { schemaVersion: 1, profiles: { 'desktop:windows': { 'test.one': primary('KeyJ') } } }
    const rows = effectiveShortcuts(definitions, document, 'desktop', 'windows')
    expect(rows.map(row => row.conflicts)).toEqual([[], [id('test.one')]])
    const both = editShortcutDocument(document, { type: 'set', id: id('test.two'), binding: { code: 'KeyJ', modifiers: ['control'] } }, 'desktop', 'windows')
    expect(effectiveShortcuts([...definitions].reverse(), both, 'desktop', 'windows').map(row => row.conflicts))
      .toEqual([[id('test.one')], [id('test.two')]])
  })

  it('keeps Linux desktop and browser reservations', () => {
    const platform = 'linux'
    const check = (code: string, modifiers: readonly ('primary' | 'control' | 'alt' | 'shift' | 'meta')[], runtime: 'web' | 'desktop' = 'desktop') =>
      bindingIssue(normalizeBinding({ code, modifiers }, platform), runtime, platform)
    for (const code of ['KeyC', 'KeyV', 'KeyX', 'KeyZ', 'KeyY', 'KeyQ', 'Tab', 'Escape', 'Space', 'Enter']) expect(check(code, ['primary'])).toBe('reserved')
    expect(check('KeyA', ['primary', 'shift'])).toBeNull()
    expect(check('KeyA', ['primary'])).toBe('reserved')
    expect(check('KeyJ', [])).toBe('modifier-required')
    expect(check('KeyJ', ['shift'])).toBe('modifier-required')
    expect(check('KeyJ', ['primary'])).toBeNull()
    for (const code of ['KeyN', 'KeyP', 'KeyW', 'KeyR', 'KeyO', 'KeyJ']) expect(check(code, ['primary'], 'web')).toBe('unsupported-browser')
    for (const code of ['Comma', 'Period']) expect(check(code, ['primary', 'shift'], 'web')).toBeNull()
    expect(check('Slash', ['primary'], 'web')).toBeNull()
    expect(check('F4', ['alt'], 'desktop')).toBe('reserved')
    expect(check('KeyL', ['meta', 'control'], 'desktop')).toBe('reserved')
  })

  it.each(['macos', 'windows'] as const)('accepts %s desktop editing and system combinations, and single keys', (platform) => {
    for (const [code, modifiers] of [
      ...['KeyC', 'KeyV', 'KeyX', 'KeyZ', 'KeyY', 'KeyA', 'KeyQ', 'KeyH', 'Tab', 'Space'].map(code => [code, ['primary']] as const),
      ['KeyC', ['control']], ['KeyX', ['control']], ['KeyN', ['shift']], ['Tab', ['control']], ['Tab', ['shift']],
      ['Escape', ['alt']], ['F4', ['alt']], ['KeyL', ['meta']], ['Delete', ['control', 'alt']],
      ['KeyL', ['control', 'meta']], ['ArrowLeft', ['alt']],
    ] as const) expect(bindingIssue(normalizeBinding({ code, modifiers }, platform), 'desktop', platform)).toBeNull()
    expect(bindingIssue(normalizeBinding({ code: 'KeyC', modifiers: [] }, platform), 'desktop', platform)).toBeNull()
    expect(bindingIssue(normalizeBinding(primary('KeyC'), platform), 'web', platform)).toBe('reserved')
    let document: ShortcutDocument = { schemaVersion: 1, profiles: {} }
    for (const entry of definitions) document = editShortcutDocument(document, { type: 'set', id: entry.id, binding: primary('KeyC') }, 'desktop', platform)
    expect(effectiveShortcuts(definitions, document, 'desktop', platform).map(row => row.conflicts))
      .toEqual([[id('test.two')], [id('test.one')]])
  })

  it.each([
    ['web', 'macos'], ['web', 'windows'], ['desktop', 'macos'], ['desktop', 'windows'],
  ] as const)('accepts three and four distinct modifiers in %s on %s and still detects conflicts', (runtime, platform) => {
    for (const modifiers of [
      ['control', 'alt', 'shift'], ['control', 'alt', 'meta'], ['control', 'shift', 'meta'],
      ['alt', 'shift', 'meta'], ['control', 'alt', 'shift', 'meta'],
    ] as const) {
      for (const code of ['KeyN', 'KeyR', 'KeyX', 'Tab', 'F4']) {
        expect(bindingIssue(normalizeBinding({ code, modifiers }, platform), runtime, platform)).toBeNull()
      }
    }
    const binding = { code: 'KeyX', modifiers: ['primary', 'alt', 'shift'] as const }
    let document: ShortcutDocument = { schemaVersion: 1, profiles: {} }
    for (const entry of definitions) document = editShortcutDocument(document, { type: 'set', id: entry.id, binding }, runtime, platform)
    expect(effectiveShortcuts(definitions, document, runtime, platform).map(row => row.conflicts))
      .toEqual([[id('test.two')], [id('test.one')]])
    expect(bindingIssue(normalizeBinding({ code: 'KeyN', modifiers: [] }, platform), runtime, platform)).toBe(runtime === 'desktop' ? null : 'modifier-required')
  })

  it('counts expanded distinct modifiers and keeps Linux reservations', () => {
    expect(normalizeBinding({ code: 'KeyX', modifiers: ['primary', 'meta', 'shift'] }, 'macos').modifiers).toEqual(['shift', 'meta'])
    expect(bindingIssue(normalizeBinding({ code: 'KeyN', modifiers: ['primary', 'control', 'control'] }, 'windows'), 'web', 'windows')).toBe('unsupported-browser')
    expect(bindingIssue(normalizeBinding({ code: 'KeyN', modifiers: ['control', 'alt', 'shift'] }, 'linux'), 'web', 'linux')).toBe('unsupported-browser')
  })

  it('leaves macOS Web refresh unbound by default while preserving overrides and other platform defaults', () => {
    const refresh = { id: id('page.refresh'), defaults: { desktop: primary('KeyR') } }
    const entries = [...definitions, refresh]
    const document: ShortcutDocument = { schemaVersion: 1, profiles: {} }
    const binding = (runtime: 'web' | 'desktop', platform: 'macos' | 'windows', source = document) =>
      effectiveShortcuts(entries, source, runtime, platform).at(-1)?.binding
    expect(binding('web', 'macos')).toBeNull()
    expect(binding('web', 'windows')).toEqual({ code: 'KeyR', modifiers: ['control', 'alt'] })
    expect(binding('desktop', 'macos')).toEqual({ code: 'KeyR', modifiers: ['meta'] })
    expect(binding('desktop', 'windows')).toEqual({ code: 'KeyR', modifiers: ['control'] })
    const custom = editShortcutDocument(document, { type: 'set', id: refresh.id,
      binding: { code: 'KeyR', modifiers: ['primary', 'alt'] } }, 'web', 'macos')
    expect(binding('web', 'macos', custom)).toEqual({ code: 'KeyR', modifiers: ['alt', 'meta'] })
    expect(binding('web', 'macos', editShortcutDocument(custom, { type: 'reset', id: refresh.id }, 'web', 'macos'))).toBeNull()
    expect(() => parseShortcutDefinitions(entries)).not.toThrow()
  })

  it('maps Windows and macOS Web defaults to three-key combinations while preserving exceptions and Linux defaults', () => {
    const entries: ShortcutDefinition[] = [
      ...definitions,
      { id: id('test.alt'), defaults: { desktop: { code: 'KeyB', modifiers: ['primary', 'alt'] } } },
      { id: id('test.archive'), defaults: { desktop: { code: 'KeyA', modifiers: ['primary', 'shift'] } } },
      { id: id('test.reference'), defaults: { desktop: primary('Slash') } },
      { id: id('test.settings'), defaults: { desktop: primary('Comma') } },
      { id: id('test.split'), defaults: { desktop: primary('Backslash') } },
      { id: id('test.terminal'), defaults: { desktop: primary('Backquote') } },
      ...['KeyR', 'KeyF', 'KeyO', 'Enter'].map(code => ({
        id: id(`test.alt.${code}`), defaults: { desktop: { code, modifiers: ['primary', 'alt'] as const } },
      })),
    ]
    const document: ShortcutDocument = { schemaVersion: 1, profiles: {} }
    const rows = effectiveShortcuts(entries, document, 'web', 'windows')
    expect(rows.map(row => row.binding)).toEqual([
      { code: 'KeyB', modifiers: ['control', 'alt'] }, { code: 'KeyJ', modifiers: ['control', 'alt'] },
      { code: 'KeyB', modifiers: ['control', 'shift'] }, { code: 'KeyA', modifiers: ['control', 'alt'] },
      { code: 'Slash', modifiers: ['control'] }, { code: 'Comma', modifiers: ['control'] },
      { code: 'Backslash', modifiers: ['control'] },
      { code: 'Backquote', modifiers: ['control'] },
      ...['KeyR', 'KeyF', 'KeyO'].map(code => ({ code, modifiers: ['control', 'shift'] })),
      { code: 'Enter', modifiers: ['control', 'alt'] },
    ])
    expect(rows.every(row => row.issue === null && row.conflicts.length === 0)).toBe(true)
    expect(effectiveShortcuts(entries, document, 'web', 'linux').every(row => row.binding === null)).toBe(true)
    const macRows = effectiveShortcuts(entries, document, 'web', 'macos')
    expect(macRows.map(row => row.binding)).toEqual([
      { code: 'KeyB', modifiers: ['alt', 'meta'] }, { code: 'KeyJ', modifiers: ['alt', 'meta'] },
      { code: 'KeyB', modifiers: ['shift', 'meta'] }, { code: 'KeyA', modifiers: ['alt', 'meta'] },
      { code: 'Slash', modifiers: ['meta'] }, { code: 'Comma', modifiers: ['meta'] },
      { code: 'Backslash', modifiers: ['meta'] }, { code: 'Backquote', modifiers: ['control'] },
      ...['KeyR', 'KeyF', 'KeyO'].map(code => ({ code, modifiers: ['shift', 'meta'] })),
      { code: 'Enter', modifiers: ['alt', 'meta'] },
    ])
    expect(macRows.every(row => row.issue === null && row.conflicts.length === 0)).toBe(true)
    expect(() => parseShortcutDefinitions(entries)).not.toThrow()
    const overridden = editShortcutDocument(document, { type: 'set', id: id('test.one'), binding: null }, 'web', 'macos')
    expect(effectiveShortcuts(entries, overridden, 'web', 'macos')[0]).toMatchObject({ modified: true, binding: null })
    for (const modifiers of [['meta', 'alt'], ['meta', 'shift']] as const) {
      expect(bindingIssue(normalizeBinding({ code: 'KeyX', modifiers }, 'macos'), 'web', 'macos')).toBeNull()
    }
    expect(bindingIssue(normalizeBinding(primary('Backquote'), 'macos'), 'web', 'macos')).toBe('unsupported-browser')
    expect(bindingIssue(normalizeBinding({ code: 'KeyB', modifiers: ['alt'] }, 'macos'), 'web', 'macos')).toBe('reserved')
    for (const modifiers of [['control', 'alt'], ['control', 'shift']] as const) {
      expect(bindingIssue(normalizeBinding({ code: 'KeyX', modifiers }, 'windows'), 'web', 'windows')).toBeNull()
    }
    expect(bindingIssue(normalizeBinding(primary('KeyN'), 'windows'), 'web', 'windows')).toBe('unsupported-browser')
    expect(() => parseShortcutDefinitions([...definitions,
      { id: id('test.collision'), defaults: { desktop: { code: 'KeyB', modifiers: ['primary', 'shift'] } } },
    ])).toThrow('Conflicting')
  })

  it('validates IPC edits and active definitions rather than trusting renderer fields', () => {
    expect(parseShortcutDefinitions(definitions)).toEqual(definitions)
    expect(parseShortcutEdit({ type: 'set', id: 'test.one', binding: null })).toEqual({ type: 'set', id: 'test.one', binding: null })
    expect(parseShortcutEdit({ type: 'reset', id: 'test.one' }).type).toBe('reset')
    expect(parseShortcutEdit({ type: 'recover' }).type).toBe('recover')
    for (const value of [null, {}, { type: 'reset', id: '../x' }, { type: 'reset-all', path: '/tmp' }, { type: 'other', id: 'test.one' }]) expect(() => parseShortcutEdit(value)).toThrow()
    for (const value of [null, [{ ...definitions[0], defaults: { desktop: null } }], [...definitions, definitions[0]],
      [{ ...definitions[0], defaults: { other: primary('KeyJ') } }], [{ ...definitions[0], defaults: { web: primary('KeyN') } }],
      [{ ...definitions[0], defaults: { desktop: primary('KeyC') } }]]) expect(() => parseShortcutDefinitions(value)).toThrow()
  })
})
