/**
 * Default model selection for an Agent without a session-specific selection.
 *
 * @module @deepseek-ai/dsh-agent-default-model
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Default model selection for Agents created without an explicit model. */
    agentDefaultModel: AgentDefaultModelConfig
  }
}

/** Settings namespace carrying the default model selection for future Agents. */
export const AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE = 'agent-default-model'

/** Stored and composed default model selection. */
export interface AgentDefaultModelSettings {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Adapter-owned reasoning effort, or provider/default behavior when absent. */
  reasoningEffort?: string
}

/** Schema of the default Agent model settings section. */
export const AGENT_DEFAULT_MODEL_SETTINGS_SCHEMA: z<AgentDefaultModelSettings> = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  reasoningEffort: z.string(),
})

/** Composition entry for the default model selection. */
export interface Config {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
}

/** Project stored settings onto the Agent-facing selection type. */
function selection(settings: AgentDefaultModelSettings): ModelSelection {
  return {
    provider: settings.provider,
    model: settings.model,
    ...settings.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(settings.reasoningEffort) },
  }
}

/**
 * Owns the default model selection independently of any Host or transport.
 * The composition entry remains usable without a settings provider; when one
 * is mounted, its user layer is read live.
 */
export class AgentDefaultModelConfig extends Service {
  static Config: z<Config> = z.object({
    provider: z.string().required(),
    model: z.string().required(),
  })

  private source: () => AgentDefaultModelSettings
  private saved: ModelSelection | undefined
  private writes: Promise<void> = Promise.resolve()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'agentDefaultModel')
    const entry: AgentDefaultModelSettings = { provider: config.provider, model: config.model }
    this.source = () => entry
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.installSection(ctx, AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE, AGENT_DEFAULT_MODEL_SETTINGS_SCHEMA, entry, {
        setSource: (current) => { this.source = current },
        // Every consumer reads through currentSelection(), so no registration-level fact
        // needs rebuilding when the settings document changes.
        onChange: () => {},
      })
    })
  }

  /**
   * Read the current default model selection.
   * @returns a detached provider, model, and optional reasoning selection.
   */
  currentSelection(): ModelSelection {
    return this.ctx.get('settings') === undefined && this.saved !== undefined
      ? { ...this.saved } : selection(this.source())
  }

  /**
   * Save the complete default model selection. A deployment without a settings
   * provider retains the selection for this process.
   * @param next - resolved selection accepted by an entry point.
   * @returns fulfillment after the optional settings write settles.
   */
  async saveSelection(next: ModelSelection): Promise<void> {
    return this.writeSelection(next, false)
  }

  /**
   * Store the initial credential setup choice only before a user selection exists.
   * @param next - available model belonging to the provider the user initialized.
   * @returns after the initial selection is saved, or immediately if already selected.
   */
  async initializeSelection(next: ModelSelection): Promise<void> {
    return this.writeSelection(next, true)
  }

  private writeSelection(next: ModelSelection, initialize: boolean): Promise<void> {
    const operation = this.writes.then(async () => {
      const user = this.ctx.get('settings')?.describe().find(entry => entry.ns === AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE)?.user
      if (initialize && (this.saved !== undefined
        || (typeof user === 'object' && user !== null && ('provider' in user || 'model' in user)))) return
      await this.ctx.get('settings')?.replace(AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE, {
        provider: next.provider,
        model: next.model,
        ...next.reasoningEffort === undefined ? {} : { reasoningEffort: String(next.reasoningEffort) },
      })
      this.saved = { ...next }
    })
    this.writes = operation.catch(() => { /* A refused write does not block the next user choice. */ })
    return operation
  }

}

export default AgentDefaultModelConfig
