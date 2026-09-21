/** Fixed input actions share their reference labels and physical-key reservations. */
import type { ShortcutFixedCommand, Shortcuts, ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * Describe built-in input and menu actions for display and conflict checking.
 * @param t - shortcut dictionary.
 * @param describeBinding - receiving device's key labels.
 * @returns read-only actions and each physical combination they occupy.
 */
export function fixedCommands(t: PropsLocale<'shortcuts'>['t'], describeBinding: Shortcuts['describeBinding']): readonly ShortcutFixedCommand[] {
  const rows = [
    { id: 'send', keys: ['Enter'], bindings: [{ code: 'Enter', modifiers: [] }], group: 'input' },
    { id: 'newline', keys: describeBinding({ code: 'Enter', modifiers: ['shift'] }).keys,
      bindings: [{ code: 'Enter', modifiers: ['shift'] }], group: 'input' },
    { id: 'complementary', keys: describeBinding({ code: 'Enter', modifiers: ['primary'] }).keys,
      bindings: [{ code: 'Enter', modifiers: ['control'] }, { code: 'Enter', modifiers: ['meta'] }], group: 'input' },
    { id: 'slash', keys: ['/'], bindings: [{ code: 'Slash', modifiers: [] }], group: 'input' },
    { id: 'mention', keys: ['@'], bindings: [{ code: 'Digit2', modifiers: ['shift'] }], group: 'input' },
    { id: 'move', keys: ['↑', '↓'], bindings: [{ code: 'ArrowUp', modifiers: [] }, { code: 'ArrowDown', modifiers: [] }], group: 'menus' },
    { id: 'select', keys: ['Enter'], bindings: [{ code: 'Enter', modifiers: [] }], group: 'menus' },
    { id: 'dismiss', keys: ['Esc'], bindings: [{ code: 'Escape', modifiers: [] }], group: 'menus' },
  ] as const
  return rows.map(row => ({ ...row, id: `fixed.${row.id}` as ShortcutCommandId, label: () => t(row.id) }))
}
