/**
 * What the manager's two surfaces say about a package, a preset row, or a
 * failure: the dictionary lookup for harness modules, the package join for
 * installed ones, and the notice copy — shared by the Manage plugins tab and
 * the capabilities section it contributes to a preset's detail page.
 */

import type { PluginPackageView } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { zh, type PluginManagerLocaleKey } from './locales.ts'
import type { ManagerNotice, PresetRow } from './manager-store.ts'

/** The translate seat of the manager's dictionary. */
export type Translate = PropsLocale<'pluginManager'>['t']

/** The scope every harness module is published under. */
const FIRST_PARTY_SCOPE = '@deepseek-ai/'

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
function copyKey(kind: 'name' | 'desc', slug: string): PluginManagerLocaleKey | undefined {
  const key = `${kind}.${slug}`
  return key in zh ? key as PluginManagerLocaleKey : undefined
}

/**
 * Display copy of one harness module: by the composition row id first (four
 * subagent rows share one module), then by the unscoped module name without
 * its `dsh-` prefix. Every `name.<slug>` key has its `desc.<slug>` partner.
 * @param t - the manager's translate seat.
 * @param moduleName - the module specifier the row names.
 * @param rowId - the row id the composition declares, when known.
 * @returns the copy, or undefined for a module outside the harness scope or
 * one the dictionary does not name.
 */
export function harnessCopy(t: Translate, moduleName: string, rowId: string | null): { title: string; description: string } | undefined {
  if (!moduleName.startsWith(FIRST_PARTY_SCOPE)) return undefined
  const slugs = [...rowId === null ? [] : [rowId], moduleName.slice(FIRST_PARTY_SCOPE.length).replace(/^dsh-/, '')]
  for (const slug of slugs) {
    const name = copyKey('name', slug)
    if (name === undefined) continue
    return { title: t(name), description: t(`desc.${slug}` as PluginManagerLocaleKey) }
  }
  return undefined
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
 * The row id a tree entry id ends in: what a user layer addresses.
 * @param entryId - the inventory's entry id, tree-wide under a live mount.
 * @returns the declared row id, or null for a row that declares none.
 */
export function rowIdOf(entryId: string | null): string | null {
  return entryId === null ? null : entryId.slice(entryId.lastIndexOf(':') + 1)
}

/**
 * What a person calls one tree entry: its harness name, else its row id.
 * @param t - the manager's translate seat.
 * @param entryId - the tree entry id.
 * @returns the label.
 */
export function rowLabel(t: Translate, entryId: string): string {
  const id = rowIdOf(entryId) as string
  const key = copyKey('name', id)
  return key === undefined ? id : t(key)
}

/**
 * What one preset row shows: a title, a one-liner, and whether the person installed it.
 * @param row - the inventory row.
 * @param packages - the profile's packages, which name the installed ones.
 * @param t - the manager's translate seat.
 * @returns the copy.
 */
export function presetRowCopy(
  row: PresetRow, packages: readonly PluginPackageView[], t: Translate,
): { title: string; description?: string; local: boolean } {
  const pkg = packageOf(row.moduleName, packages)
  if (pkg !== undefined) {
    const addable = pkg.addable.find(entry => entry.moduleName === row.moduleName)
    return {
      title: addable?.title ?? pkg.title ?? shortName(pkg.name),
      ...pkg.description === undefined ? {} : { description: pkg.description },
      local: pkg.installed,
    }
  }
  const harness = harnessCopy(t, row.moduleName, rowIdOf(row.entryId))
  if (harness !== undefined) return { ...harness, local: false }
  return { title: shortName(row.moduleName), description: row.moduleName, local: !row.moduleName.startsWith(FIRST_PARTY_SCOPE) }
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
    case 'failed': {
      switch (notice.code) {
        case 'plugins/not-enableable': return t('notEnableable', { reason: notice.reason })
        case 'plugins/enable-failed': return t('enableFailed', { reason: notice.reason })
        case 'plugins/row-conflict': return t('rowConflict', { row: notice.rowId ?? '' })
        case 'plugins/not-installed': return t('notInstalled', { name: notice.packageName ?? '' })
        default: return refusalText(notice, t)
      }
    }
  }
}
