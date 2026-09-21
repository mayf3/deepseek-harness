/**
 * The shell executor's settings page, browser half: the command timeout and
 * the per-stream output cap over the `shell` namespace the executor
 * registers. The page registers into the Plugins page's `plugins.item` slot
 * while the Host serves that namespace, so a deployment without a local shell
 * executor shows no trace of it.
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.settingsScope Context merge. Cross-plugin collaboration
// goes through the service, never a value import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the Plugins page's SlotMap merge (the 'plugins.item' entry).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { ShellCard } from './ShellCard.tsx'
import { SHELL_NS, ShellCardController } from './shell-card-controller.ts'
import { en, zh, type ShellSettingsLocaleKey } from './locales.ts'

export type { ShellCardProps } from './ShellCard.tsx'
export type { ShellCardFace, ShellCardState, ShellSettings } from './shell-card-controller.ts'
export type { ShellSettingsLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Shell settings page copy. */
    'settings.shell': ShellSettingsLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.shell'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'settingsScope']

/**
 * Mount the shell settings page while the Host serves its namespace.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-shell: dictionaries')
  const card = new ShellCardController(ctx.settingsScope.bind({ namespace: SHELL_NS }))
  ctx.effect(() => ctx.settingsScope.whileServed([SHELL_NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item', id: 'shell', order: 10, label: () => t('title'), locale: NS, inject: () => card.inject(),
  }, ShellCard))), 'ui-settings-shell: page')
}
