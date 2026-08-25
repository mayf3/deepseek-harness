import type { Context } from '@deepseek-ai/cordis'
import { existsSync, writeFileSync } from 'node:fs'
import { setTimeout } from 'node:timers/promises'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

/**
 * Scripted model for the CHILD runtime: normally answers with its process cwd;
 * under DSH_TEST_CHILD_FAILURE it streams partial text and ends with a fixed
 * provider failure so the parent can assert DSH SDK diagnostics.
 */
class CwdEchoAdapter extends LlmAdapter {
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    void options
    const ready = process.env.FAKE_INIT_READY
    const release = process.env.FAKE_INIT_GO
    if (ready !== undefined) writeFileSync(ready, 'ready\n')
    if (release !== undefined) {
      const deadline = Date.now() + 30_000
      while (!existsSync(release)) {
        if (Date.now() > deadline) throw new Error(`child mock timed out waiting for ${release}`)
        await setTimeout(10)
      }
    }
    const failure = process.env.DSH_TEST_CHILD_FAILURE === '1'
    const reply = failure ? 'partial child loader answer' : `child cwd: ${process.cwd()}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 3, outputTokens: reply.length } }
    yield failure
      ? { type: 'finish', reason: { kind: 'error', failure: { code: 'CHILD_TEST_FAILURE', message: 'child loader failure' } } }
      : { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'child-mock-llm'
export const inject = ['llm']

/**
 * Register the cwd-echo adapter under the `mock` provider.
 * @param ctx - the plugin context supplying `ctx.llm`.
 */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['mock'], new CwdEchoAdapter())
}
