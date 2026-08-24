/** Host-owned opt-in setting for model-selectable subagent delegation. */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  AllowedModelRouteSchema,
  assertAllowedModelRoutes,
  type AllowedModelRoute,
} from './model-selection.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** User preference sampled when a new Agent receives its delegation tools. */
    subagentModelSelection: SubagentModelSelectionConfig
  }
}

/** User-settings section for model-selectable subagent delegation. */
export const SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE = settingsNamespace('subagent-model-selection')

/** Stored user preference; the shipped composition defaults it off. */
export interface SubagentModelSelectionSettings {
  /** Exact child LLM routes offered to newly composed top-level Sessions. */
  allowedModels: AllowedModelRoute[]
}

/** Schema served to settings clients for the opt-in preference. */
export const SUBAGENT_MODEL_SELECTION_SETTINGS_SCHEMA: z<SubagentModelSelectionSettings> = z.object({
  allowedModels: z.array(AllowedModelRouteSchema).default([]),
})

/** Optional deployment base for the preference. */
export interface Config {
  /** Initial route list inherited when the user document does not override it. */
  allowedModels?: AllowedModelRoute[]
}

/** Singleton settings owner read by delegation tools when an Agent is published. */
export class SubagentModelSelectionConfig extends Service {
  static Config: z<Config> = z.object({
    allowedModels: z.array(AllowedModelRouteSchema).default([]),
  })

  private source: () => SubagentModelSelectionSettings

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'subagentModelSelection')
    // Cordis supplies the schema default; the fallback also covers direct construction.
    /* v8 ignore next */
    const entry: SubagentModelSelectionSettings = { allowedModels: config.allowedModels ?? [] }
    assertAllowedModelRoutes(entry.allowedModels)
    this.source = () => entry
    installSettingsSection(
      ctx,
      SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE,
      SUBAGENT_MODEL_SELECTION_SETTINGS_SCHEMA,
      entry,
      {
        setSource: (source) => { this.source = source },
        validate: (value) => { assertAllowedModelRoutes(value.allowedModels) },
        // Consumers sample at Agent publication, so a settings update never
        // rebuilds the tool definitions of an Agent that is already running.
        onChange: () => {},
      },
    )
  }

  /**
   * Read a detached route policy for the next eligible Agent publication.
   * @returns exact allowed routes; an empty list disables model-facing selection.
   */
  currentAllowedModels(): AllowedModelRoute[] {
    return this.source().allowedModels.map(route => ({ ...route }))
  }
}

export const name = 'subagent-model-selection-settings'
export default SubagentModelSelectionConfig
