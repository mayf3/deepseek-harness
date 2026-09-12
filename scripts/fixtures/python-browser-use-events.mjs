/** Replay Stagehand's recorded auxiliary events through the packaged SDK's event projection. */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

export const name = 'python-browser-use-events'
export const inject = ['sessions']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - Snapshot runtime services.
 */
export function apply(ctx) {
  const fixture = new URL('../../snapshots/session/browser-use-stagehand-native/session.v3.jsonl', import.meta.url)
  const events = readFileSync(fixture, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line))
  const request = events.find(event => event.type === 'browser-use/stagehand-llm-request')
  const result = events.find(event => event.type === 'browser-use/stagehand-llm-result')
  if (request === undefined || result === undefined) throw new Error('Stagehand recording lacks auxiliary inference events')

  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (agent.session.header.parentSession !== undefined) return
    const before = JSON.stringify(agent.session.deriveMessages())
    const requestData = structuredClone(request.data)
    requestData.request.sessionId = agent.session.id
    for (const message of requestData.request.messages) message.id = randomUUID()
    const logged = agent.session.append(request.type, requestData)
    await ctx.sessions.flush(agent.session)
    agent.session.append(result.type, { ...structuredClone(result.data), requestSeq: logged.seq })
    await ctx.sessions.flush(agent.session)
    if (JSON.stringify(agent.session.deriveMessages()) !== before) {
      throw new Error('Stagehand auxiliary events changed model-visible messages')
    }
  })
}
