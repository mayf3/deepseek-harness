/**
 * Settings domain base plugin, browser half. Provides `ctx.settingsScope`, the
 * settings-namespace Host transport every preference row binds its durable
 * section through, and owns the canonical slot-type contract for the settings
 * surface. It depends on no `ui-*` presentation package, so any feature that
 * owns a preference can reach it: the settings SHELL — the `sidebar.settings`
 * occupant, its navigation, and the chrome — lives in ui-settings-general,
 * because a shell dependency on ui-sidebar would close a reference cycle
 * through ui-layout and ui-theme. Export discipline: packages/client/AGENTS.md.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { SettingsSchemaService } from './schema.ts'
import { SettingsScopeBinder } from './settings-scope.ts'

export type {
  SettingsGeneralItemOwnerProps, SettingsHeaderOwnerProps, SettingsOnboardingOwnerProps,
  SettingsPluginsTabOwnerProps, SettingsSectionOwnerProps, SettingsTriggerOwnerProps,
} from './contract/slots.ts'
export type { SettingsScopeController, SettingsScopeBinder } from './settings-scope.ts'
export type { SettingsSchemaService } from './schema.ts'
export type { SchemaNode } from './schema.ts'

/**
 * Required services: none. The transport is resolved per caller through
 * `this.ctx` at `bind` time, so this plugin waits for nothing.
 */
export const inject = []

/**
 * Provide the settings-namespace scope service.
 *
 * Constructing the service in this plugin's fiber keeps its traced methods
 * bound to each consuming plugin's context.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const schema = new SettingsSchemaService(ctx)
  new SettingsScopeBinder(ctx, schema)
}
