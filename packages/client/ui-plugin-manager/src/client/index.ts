/**
 * Plugin manager, browser half: the **Plugins** entry of the sidebar and the
 * management page it opens in the main column, and the capabilities section
 * of every agent preset's detail page. The page installs, enables, disables,
 * retries, and uninstalls the packages of the Host's profile through the
 * `plugins` Remote; the section composes rows into one preset's user layer.
 * Configuring a plugin stays in Settings.
 */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the root `main` keyed slot the page registers into, declared by
// ui-layout with the panel id brand, and the `sidebar.panellist` list the
// entry registers into, declared by ui-sidebar.
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the ctx.remote Context merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: the forwarded events' own declaration (`$on`'s key face resolves
// through the owning package's client-safe types subpath).
import type {} from '@deepseek-ai/dsh-host-plugin-manager/types'
// Type-only: the 'settings.agentPreset' LocaleNamespaceMap merge the
// shipped-preset name resolution reads, and the `settings.agentPreset.detail`
// slot the capabilities section registers into.
import type {} from '@deepseek-ai/dsh-client-ui-agent-preset/client'
// Inline-safe shared fold: shipped ids map to dictionary keys in one home.
import { presetDisplayText } from '@deepseek-ai/dsh-agent-presets/display'
import { PluginManagerPage } from './PluginManagerPage.tsx'
import { PluginsPanelIcon } from './PluginsPanelIcon.tsx'
import { PresetPluginsSection } from './PresetPluginsSection.tsx'
import { PluginManagerController } from './manager-store.ts'
import { en, zh, type PluginManagerLocaleKey } from './locales.ts'

export type { PluginManagerPageProps } from './PluginManagerPage.tsx'
export type { PresetPluginsSectionProps } from './PresetPluginsSection.tsx'
export type {
  ConfirmState, InstallState, ManagerNotice, PluginManagerFace, PluginManagerState, PresetGroup, PresetRow,
} from './manager-store.ts'
export type { PluginManagerLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Plugin manager tab copy. */
    'pluginManager': PluginManagerLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'pluginManager'

/** The id shared by the sidebar entry and the main panel it opens. */
export const PANEL_ID = 'plugins' as MainPanelId

/** Services required by the Settings registration and the two Remote faces. */
export const inject = ['slots', 'locale', 'remote', 'remote.plugins', 'remote.pluginInventory']

/**
 * Contribute the Plugins entry to the sidebar with the management page it
 * opens, and the capabilities section to every preset's detail page, and
 * keep both current on the Host's change events.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-plugin-manager: dictionaries')
  const t = ctx.locale.bind(NS)
  const agentPresetCopy = ctx.locale.bind('settings.agentPreset')
  const controller = new PluginManagerController(ctx, preset => presetDisplayText(preset, agentPresetCopy).name)
  ctx.effect(() => () => { controller.dispose() }, 'ui-plugin-manager: controller')
  // The Host says when what is installed, enabled, or composed changed — from
  // this page, the CLI, or another browser — and streams install output.
  ctx.effect(() => {
    // A page never rendered holds no snapshot to refresh.
    const refresh = (): void => {
      if (controller.getSnapshot().status !== 'idle') void controller.load()
    }
    const disposers = [
      ctx.remote.$on('plugins/changed', refresh),
      ctx.remote.$on('plugins/install-log', (chunk) => { controller.appendLog(chunk) }),
      ctx.on('connection/reset', refresh),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'ui-plugin-manager: host invalidations')

  // The page is a global panel: it belongs to the profile, not to a Session,
  // and the sidebar's entry selects it. How a plugin is configured stays in
  // Settings; this page is what is installed and switched on.
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => controller.inject(),
  }, PluginManagerPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 0,
    label: () => t('panel'),
    locale: NS,
  }, PluginsPanelIcon))

  ctx.slots.inject('settings.agentPreset.detail', () => ctx.slots.register({
    name: 'settings.agentPreset.detail',
    id: 'plugins',
    order: 0,
    locale: NS,
    inject: () => controller.inject(),
  }, PresetPluginsSection))
}
