/**
 * Plugin manager, browser half: the **Manage plugins** tab of the Plugins
 * settings section. It installs, enables, disables, retries, and uninstalls
 * the packages of the Host's profile through the `plugins` Remote, and
 * composes rows into the global user layer or one agent preset's.
 */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the `settings.plugins.tab` slot this tab registers into is
// declared by ui-settings-plugins; registration goes through `slots.inject`.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the ctx.remote Context merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: the forwarded events' own declaration (`$on`'s key face resolves
// through the owning package's client-safe types subpath).
import type {} from '@deepseek-ai/dsh-host-plugin-manager/types'
// Type-only: pulls the 'settings.agentPreset' LocaleNamespaceMap merge, whose
// dictionaries the shipped-preset name resolution below reads.
import type {} from '@deepseek-ai/dsh-client-ui-agent-preset/client'
// Inline-safe shared fold: shipped ids map to dictionary keys in one home.
import { presetDisplayText } from '@deepseek-ai/dsh-agent-presets/display'
import { PluginManagerSettingsTab } from './PluginManagerSettingsTab.tsx'
import { PluginManagerController } from './manager-store.ts'
import { en, zh, type PluginManagerLocaleKey } from './locales.ts'

export type { PluginManagerSettingsTabProps } from './PluginManagerSettingsTab.tsx'
export type {
  ConfirmState, InstallState, ManagerNotice, PluginManagerFace, PluginManagerState, PresetGroup, PresetRow,
} from './manager-store.ts'
export type { PluginManagerLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Plugin manager tab copy. */
    'settings.pluginManager': PluginManagerLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.pluginManager'

/** Services required by the Settings registration and the two Remote faces. */
export const inject = ['slots', 'locale', 'remote', 'remote.plugins', 'remote.pluginInventory']

/**
 * Contribute the manager tab to the Plugins settings section, and keep it
 * current on the Host's change events.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-plugin-manager: dictionaries')
  const t = ctx.locale.bind(NS)
  const agentPresetCopy = ctx.locale.bind('settings.agentPreset')
  const controller = new PluginManagerController(ctx, preset => presetDisplayText(preset, agentPresetCopy).name)
  ctx.effect(() => () => { controller.dispose() }, 'ui-settings-plugin-manager: controller')
  // The Host says when what is installed, enabled, or composed changed — from
  // this page, the CLI, or another browser — and streams install output.
  ctx.effect(() => {
    // A tab never rendered holds no snapshot to refresh.
    const refresh = (): void => {
      if (controller.getSnapshot().status !== 'idle') void controller.load()
    }
    const disposers = [
      ctx.remote.$on('plugins/changed', refresh),
      ctx.remote.$on('plugins/install-log', (chunk) => { controller.appendLog(chunk) }),
      ctx.on('connection/reset', refresh),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'ui-settings-plugin-manager: host invalidations')

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'manage',
    order: 5,
    label: () => t('tab'),
    locale: NS,
    inject: () => controller.inject(),
  }, PluginManagerSettingsTab))
}
