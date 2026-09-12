/** Plain-Node smoke of the published provider, attachment Worker, and DSH model bridge. */
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import BrowserUseRegistry from '@deepseek-ai/dsh-browser-use'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as Provider from '../../lib/index.js'

class StructuredModel extends LlmAdapter {
  async *stream(options) {
    if (!JSON.stringify(options.messages).includes('Stagehand local smoke')) throw new Error('Stagehand did not read the controlled page')
    const schema = options.tools[0].parameters.properties.result
    const value = Object.hasOwn(schema.properties, 'progress')
      ? { progress: 'Read the heading.', completed: true }
      : { heading: 'Stagehand local smoke' }
    yield {
      type: 'block-end', index: 0,
      block: { type: 'tool-call', id: ToolCallId('built-inference'), name: 'stagehand_result', arguments: JSON.stringify({ result: value }) },
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

const [endpoint, url] = process.argv.slice(2)
const ctx = new Context()
try {
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(BrowserUseRegistry)
  ctx.llm.registerAdapter(['fixture'], new StructuredModel())
  const provider = ctx.plugin(Provider, { mode: 'attach', cdpEndpoint: endpoint })
  await provider
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('built-stagehand'), { provider: 'fixture', model: 'structured' })
  const call = async (method, args) => {
    const result = await ctx.tools.execute({ agent, name: `stagehand_${method}`, arguments: args, callId: ToolCallId(`built-${method}`), signal: new AbortController().signal })
    if (result.isError) throw new Error(JSON.stringify(result.content))
    return result
  }
  await call('tabs', { action: 'new', url })
  const result = await call('extract', {
    instruction: 'Extract the exact h1 heading.',
    schema: { type: 'object', properties: { heading: { type: 'string' } }, required: ['heading'], additionalProperties: false },
  })
  const requests = agent.session.snapshotEvents().filter(event => event.type === 'browser-use/stagehand-llm-request')
  const responses = agent.session.snapshotEvents().filter(event => event.type === 'browser-use/stagehand-llm-result')
  await provider.dispose()
  process.stdout.write(JSON.stringify({ result: result.content, requests: requests.length, responses: responses.length }) + '\n')
} finally {
  await ctx.fiber.dispose()
}
