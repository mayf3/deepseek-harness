/** Keyless model route and persisted-agent resume for first-request pressure. */
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

class PressureAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 16000 } })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const messages = JSON.stringify(options.messages)
    const text = options.purpose === 'compaction'
      ? 'PRESSURE CHECKPOINT'
      : messages.includes('PRESSURE CHECKPOINT') && !messages.includes('HISTORY SENTINEL')
        ? 'COMPACTION PRESSURE PASSED'
        : 'UNCOMPACTED REQUEST'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'compaction-pressure-agent'
export const inject = ['llm', 'agents', 'agentLoop', 'sessionPersistence']

/**
 * Route a headerless resumed agent through a model with known capacity.
 * @param ctx - Loader context providing the real loop and persistence.
 * @returns after the resumed agent is ready for the headless driver.
 */
export async function apply(ctx: Context): Promise<void> {
  ctx.effect(() => ctx.llm.registerAdapter(['pressure-provider'], new PressureAdapter()))
  ctx.on('agent/request', async (_payload, next) => ({
    ...await next(), provider: 'pressure-provider', model: 'pressure-model',
  }))
  const handle = await ctx.agents.resume({ resumeSessionId: SessionId('compaction-pressure'), agentOptions: {} })
  ctx.effect(() => () => handle.dispose(), 'compaction-pressure-agent.handle')
}
