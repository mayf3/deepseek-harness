/** Localized failures shared by direct removal and inline shortcut editing. */
import type { ShortcutSaveResult } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import type { ShortcutCatalogEntry } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * Describe an unsuccessful preference write without losing command names.
 * @param result - rejected operation result.
 * @param catalog - current command labels.
 * @param t - shortcut dictionary.
 * @returns localized diagnosis for a system toast and accessible field description.
 */
export function shortcutFailure(result: ShortcutSaveResult, catalog: readonly Pick<ShortcutCatalogEntry, 'id' | 'label'>[], t: PropsLocale<'shortcuts'>['t']): string {
  return result.issue ? t(result.issue) : result.status === 'conflict'
    ? t('conflict', { commands: result.conflicts?.map(id => catalog.find(row => row.id === id)?.label ?? id).join(', ') ?? '' })
    : t(result.status)
}
