/** Display labels and failure messages for global plugin management. */

import type { PluginPackageView } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { zh, type PluginManagerLocaleKey } from './locales.ts'
import type { ManagerNotice } from './manager-store.ts'

/** The translate seat of the manager's dictionary. */
export type Translate = PropsLocale<'pluginManager'>['t']

/**
 * Compact a package name to what a person calls it.
 * @param name - the package name.
 * @returns the unscoped name without the harness prefixes.
 */
export function shortName(name: string): string {
  const unscoped = name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name
  return unscoped.replace(/^dsh-(?:host-|client-)?/, '')
}

/** The dictionary key for one slug, when the dictionary carries it. */
function copyKey(slug: string): PluginManagerLocaleKey | undefined {
  const key = `name.${slug}`
  return key in zh ? key as PluginManagerLocaleKey : undefined
}

/**
 * The installed package a module belongs to: the package itself or one of its subpaths.
 * @param moduleName - the module specifier.
 * @param packages - the profile's packages.
 * @returns the owning package view, or undefined when no installed package owns it.
 */
export function packageOf(moduleName: string, packages: readonly PluginPackageView[]): PluginPackageView | undefined {
  return packages.find(pkg => moduleName === pkg.name || moduleName.startsWith(`${pkg.name}/`))
}

/**
 * What a person calls one tree entry: its harness name, else its row id.
 * @param t - the manager's translate seat.
 * @param entryId - the tree entry id.
 * @returns the label.
 */
export function rowLabel(t: Translate, entryId: string): string {
  const id = entryId.slice(entryId.lastIndexOf(':') + 1)
  const key = copyKey(id)
  return key === undefined ? id : t(key)
}

/**
 * The copy for a refusal every mutation can meet: the manager is busy, or a session is running.
 * @param failure - the Host's code and reason.
 * @param t - the manager's translate seat.
 * @returns the sentence.
 */
export function refusalText(failure: { readonly code: string; readonly reason: string }, t: Translate): string {
  switch (failure.code) {
    case 'plugins/busy': return t('busy', { reason: failure.reason })
    case 'plugins/agents-running': return t('agentsRunning', { reason: failure.reason })
    default: return failure.code === 'plugins/install-failed' ? t('installFailed') : t('actionFailed', { reason: failure.reason })
  }
}

/**
 * The sentence one notice shows.
 * @param notice - the last action's outcome.
 * @param t - the manager's translate seat.
 * @returns the sentence.
 */
export function noticeText(notice: ManagerNotice, t: Translate): string {
  switch (notice.kind) {
    case 'restart': return t('restartNotice')
    case 'cancelled': return t('installCancelled')
    case 'failed': {
      switch (notice.code) {
        case 'plugins/not-enableable': return t('notEnableable', { reason: notice.reason })
        case 'plugins/enable-failed': return t('enableFailed', { reason: notice.reason })
        case 'plugins/not-installed': return t('notInstalled', { name: notice.packageName ?? '' })
        default: return refusalText(notice, t)
      }
    }
  }
}
