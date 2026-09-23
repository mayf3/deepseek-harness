/**
 * Default model selection for an Agent without a session-specific selection.
 *
 * @module @deepseek-ai/dsh-agent-default-model
 */
import type {} from '@deepseek-ai/dsh-settings'

import type { Volatile } from '@deepseek-ai/cordis'

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-config-editor'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Default model selection for Agents created without an explicit model. */
    agentDefaultModel: AgentDefaultModelConfig
  }
}

/** Default model selection supplied by plugin configuration. */
export interface Config {
  /** Registered provider route. */
  provider: Volatile<string>
  /** Provider-owned model id. */
  model: Volatile<string>
  /** Adapter-owned reasoning effort; omission follows the provider default. */
  reasoningEffort: Volatile<string | undefined>
}

/** Project stored settings onto the Agent-facing selection type. */
function selection(settings: { provider: string; model: string; reasoningEffort?: string }): ModelSelection {
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
 * Each operation reads the owning Config references.
 */
export class AgentDefaultModelConfig extends Service {
  static Config = z.object({
    provider: z.string().required().volatile(),
    model: z.string().required().volatile(),
    reasoningEffort: z.string().volatile(),
  })

  private writes: Promise<void> = Promise.resolve()

  constructor(private readonly ownerContext: Context, private config: Config) {
    super(ownerContext, 'agentDefaultModel')

    ownerContext.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ownerContext.fiber)) })
  }

  /**
   * Read the current default model selection.
   * @returns a detached provider, model, and optional reasoning selection.
   */
  currentSelection(): ModelSelection {
    const reasoningEffort = this.config.reasoningEffort.get()
    return selection({
      provider: this.config.provider.get(), model: this.config.model.get(),
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
    })
  }

  /**
   * Save the complete default model selection. A deployment without a configuration
   * editor keeps its composition entry.
   * @param next - resolved selection accepted by an entry point.
   * @returns fulfillment after the optional profile write settles.
   */
  async saveSelection(next: ModelSelection): Promise<void> {
    return this.writeSelection(next, false)
  }

  /**
   * Store the initial setup choice only before an explicit profile selection exists.
   * @param next - available model belonging to the initialized provider.
   * @returns after the initial choice is saved or an existing choice is retained.
   */
  async initializeSelection(next: ModelSelection): Promise<void> {
    return this.writeSelection(next, true)
  }

  private writeSelection(next: ModelSelection, initialize: boolean): Promise<void> {
    const operation = this.writes.then(async () => {
      const entry = this.ownerContext.fiber.entry
      const editor = this.ctx.get('configEditor')
      if (entry === undefined || editor === undefined) return
      const override = editor.configuration().find(row => row.entry === entry)?.override
      if (initialize && override !== undefined && ('provider' in override || 'model' in override)) return
      await editor.edit(entry, () => ({
        provider: next.provider, model: next.model,
        ...next.reasoningEffort === undefined ? {} : { reasoningEffort: String(next.reasoningEffort) },
      }))
    })
    this.writes = operation.catch(() => { /* A refused write does not block the next user choice. */ })
    return operation
  }
}

export default AgentDefaultModelConfig
