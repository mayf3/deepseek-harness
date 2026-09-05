/**
 * Plugins settings surface, browser half — one section whose feature-owned
 * tabs include configurable Host plugin cards, and the settings section of
 * every agent preset's detail page.
 *
 * The section declares `settings.plugins.tab`; its own `configurable` tab then
 * declares `settings.plugin.item` and renders whatever cards were registered
 * into it, editing the global instance of each namespace. The preset detail
 * section declares `settings.agentPreset.plugin.item` and renders the cards
 * registered there under the preset's own scope. The cards this package ships
 * are the host-plane sections the deployment already exposes, registered under
 * both slots; each binds its namespace through the client settings scope,
 * which keeps them unaware of one another and of other surfaces.
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the settings shell's SlotMap merge (the 'settings.section' entry)
// and the ctx.settingsScope Context merge. Cross-plugin collaboration goes
// through the service, never a value import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the ctx.remote Context merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: the `settings.agentPreset.detail` slot the preset settings
// section registers into, declared by the roster.
import type {} from '@deepseek-ai/dsh-client-ui-agent-preset/client'
import { AgentLoopCard } from './AgentLoopCard.tsx'
import { BashCard } from './BashCard.tsx'
import { ConfigurablePluginsTab } from './ConfigurablePluginsTab.tsx'
import { PluginsSettingsSection } from './PluginsSettingsSection.tsx'
import { PresetSettingsSection, type PresetSettingsFace } from './PresetSettingsSection.tsx'
import type { PluginsSettingsSectionInjected, PluginsSettingsTabEntry } from './PluginsSettingsSection.tsx'
import { SkillFilesystemCard } from './SkillFilesystemCard.tsx'
import { SubagentModelSelectionCard } from './SubagentModelSelectionCard.tsx'
import { WebSearchCard } from './WebSearchCard.tsx'
import { AGENT_LOOP_NS, AgentLoopCardController } from './agent-loop-card-controller.ts'
import { SHELL_NS, BashCardController } from './bash-card-controller.ts'
import { ConfigurablePluginsTabController } from './tab-store.ts'
import { ScopeSelection } from './scoped-form.ts'
import type { CardSlot } from './slot-contract.ts'
import { SKILL_FILESYSTEM_NS, SkillFilesystemCardController } from './skill-filesystem-card-controller.ts'
import {
  SUBAGENT_MODEL_SELECTION_NS, SubagentModelSelectionCardController,
} from './subagent-model-selection-card-controller.ts'
import { WEB_SEARCH_NS, WebSearchCardController } from './web-search-card-controller.ts'
import { en, zh } from './locales.ts'

export type { PluginsSettingsSectionInjected, PluginsSettingsSectionProps } from './PluginsSettingsSection.tsx'
export type { ConfigurablePluginsTabProps } from './ConfigurablePluginsTab.tsx'
export type { PresetSettingsFace, PresetSettingsSectionProps } from './PresetSettingsSection.tsx'
export type { ConfigurablePluginsTabFace, ConfigurablePluginsTabState } from './tab-store.ts'
export type { BindScope, ScopeSelectionState } from './scoped-form.ts'
export type { PluginCardProps } from './PluginCard.tsx'
export type { CardSlot, SettingsPluginItemOwnerProps } from './slot-contract.ts'
export type { FieldProps } from './fields.tsx'
export type {
  CardActions, CardFieldSpec, CardFieldState, CardSecretSpec, CardShell,
} from './card-form.ts'
export type { AgentLoopCardFace, AgentLoopCardState } from './agent-loop-card-controller.ts'
export type { BashCardFace, BashCardState } from './bash-card-controller.ts'
export type { SkillFilesystemCardFace, SkillFilesystemCardState } from './skill-filesystem-card-controller.ts'
export type { WebSearchCardFace, WebSearchCardState } from './web-search-card-controller.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.plugins'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'remote.session', 'settingsScope']

/**
 * Mount the plugin configuration section, the settings section of every
 * preset's detail page, and the cards this package ships under both.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-plugins: section dictionaries')

  // One scope selection over every card: the global instance while the
  // configuration tab shows, one preset's scope while that preset's detail
  // page is open. The settings shell mounts one section at a time, so the two
  // surfaces never hold the selection together. A card binds its namespace
  // under a scope the first time that scope is selected.
  const selection = new ScopeSelection()
  const bindScope = <T>(namespace: string) => (scope: string | undefined) =>
    ctx.settingsScope.bind<T>({ namespace, ...scope === undefined ? {} : { scope } })
  const bash = new BashCardController(selection, bindScope(SHELL_NS))
  const agentLoop = new AgentLoopCardController(selection, bindScope(AGENT_LOOP_NS))
  const webSearch = new WebSearchCardController(selection, bindScope(WEB_SEARCH_NS), ctx)
  const subagentModelSelection = new SubagentModelSelectionCardController(
    selection, bindScope(SUBAGENT_MODEL_SELECTION_NS), ctx)
  const skillFilesystem = new SkillFilesystemCardController(selection, bindScope(SKILL_FILESYSTEM_NS))

  // The credential a card reports is not part of any settings section, so its
  // scope publishes nothing when one is written. This is the only signal that
  // a key written on another surface reached the Host.
  ctx.effect(
    () => ctx.remote.$on('credentials/reference-updated', (ref) => { webSearch.refreshCredential(ref) }),
    'ui-settings-plugins: credential invalidations',
  )
  ctx.effect(
    () => ctx.remote.$on('llm/adapters-updated', () => { subagentModelSelection.refreshCatalog() }),
    'ui-settings-plugins: subagent adapter invalidations',
  )
  ctx.effect(
    () => ctx.remote.$on('settings/document-updated', () => { subagentModelSelection.refreshCatalog() }),
    'ui-settings-plugins: subagent settings invalidations',
  )
  ctx.effect(
    () => ctx.on('connection/reset', () => { subagentModelSelection.resetConnection() }),
    'ui-settings-plugins: subagent connection generation',
  )
  ctx.effect(() => () => { subagentModelSelection.dispose() }, 'ui-settings-plugins: subagent preference')

  // One card directory per surface over the shared SettingsScope mirror, which
  // updates after document commits and reconnects.
  const describeFace = ctx.settingsScope.describe()
  const directory = (slot: CardSlot): ConfigurablePluginsTabController => {
    const controller = new ConfigurablePluginsTabController(describeFace, () => ctx.slots.entries(slot))
    ctx.effect(() => () => { controller.dispose() }, `ui-settings-plugins: ${slot} directory`)
    // A card registered after the first read joins the list without a wire call.
    ctx.effect(() => ctx.slots.subscribe(slot, () => { controller.refresh() }), `ui-settings-plugins: ${slot} ledger`)
    return controller
  }
  const configurable = directory('settings.plugin.item')
  const presetSettings = directory('settings.agentPreset.plugin.item')

  let tabsVersion = -1
  let tabsRevision = -1
  let tabs: readonly PluginsSettingsTabEntry[] = []
  const sectionInjected = (): PluginsSettingsSectionInjected => ({
    hooks: {
      tabs: {
        getSnapshot: () => {
          const version = ctx.slots.getVersion('settings.plugins.tab')
          const revision = ctx.locale.getSnapshot().revision
          if (version !== tabsVersion || revision !== tabsRevision) {
            tabsVersion = version
            tabsRevision = revision
            tabs = ctx.slots.entries('settings.plugins.tab')
              .map(entry => ({
                /* v8 ignore next -- list-slot registration requires id */
                id: entry.options.id ?? '',
                order: entry.options.order ?? 0,
                label: resolveSlotLabel(entry.options.label) ?? '',
              }))
              .sort((a, b) => a.order - b.order)
          }
          return tabs
        },
        subscribe: (listener) => {
          const offLedger = ctx.slots.subscribe('settings.plugins.tab', listener)
          const offLocale = ctx.locale.subscribe(listener)
          return () => {
            offLedger()
            offLocale()
          }
        },
      },
    },
  })

  // This package owns the one Plugins navigation entry and the tab chrome;
  // feature plugins contribute pages without competing for Settings nav rows.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'plugins',
    order: 15,
    label: () => t('nav'),
    locale: NS,
    inject: sectionInjected,
    children: { 'settings.plugins.tab': { kind: 'list', scope: 'root' } },
  }, PluginsSettingsSection))

  // The existing configuration page is one ordinary tab. It keeps ownership
  // of the card slot and the shipped card contributions below.
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'configurable',
    order: 0,
    label: () => t('configurableTab'),
    locale: NS,
    inject: () => configurable.inject(),
    children: { 'settings.plugin.item': { kind: 'keyed', scope: 'root' } },
  }, ConfigurablePluginsTab))

  // The settings section of every preset's detail page: the same cards under
  // the preset's scope, after the plugin manager's capabilities section.
  ctx.slots.inject('settings.agentPreset.detail', () => ctx.slots.register({
    name: 'settings.agentPreset.detail',
    id: 'settings',
    order: 10,
    locale: NS,
    inject: (): PresetSettingsFace => ({
      ...presetSettings.inject(),
      selectScope: (scope) => { selection.select(scope ?? undefined) },
    }),
    children: { 'settings.agentPreset.plugin.item': { kind: 'keyed', scope: 'root' } },
  }, PresetSettingsSection))

  // The shipped cards, under both surfaces.
  const cards = (name: CardSlot) => function* () {
    yield ctx.slots.register({ name, key: SHELL_NS, locale: NS, inject: () => bash.inject() }, BashCard)
    yield ctx.slots.register({ name, key: AGENT_LOOP_NS, locale: NS, inject: () => agentLoop.inject() }, AgentLoopCard)
    yield ctx.slots.register({
      name, key: SUBAGENT_MODEL_SELECTION_NS, locale: NS, inject: () => subagentModelSelection.inject(),
    }, SubagentModelSelectionCard)
    yield ctx.slots.register({ name, key: WEB_SEARCH_NS, locale: NS, inject: () => webSearch.inject() }, WebSearchCard)
    yield ctx.slots.register({
      name, key: SKILL_FILESYSTEM_NS, locale: NS, inject: () => skillFilesystem.inject(),
    }, SkillFilesystemCard)
  }
  ctx.slots.inject('settings.plugin.item', cards('settings.plugin.item'))
  ctx.slots.inject('settings.agentPreset.plugin.item', cards('settings.agentPreset.plugin.item'))
}
