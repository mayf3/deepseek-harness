import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, LlmError } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MockAdapter, textResponse } from './mock-adapter.ts'

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function message(text: string): ReturnType<typeof createUserMessage> {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

describe('agent/pre-request', () => {
  it('awaits logged-surface updates after routing on every request attempt', async () => {
    const adapter = new MockAdapter([
      () => { throw new LlmError('retry once', 'SERVER') },
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    try {
      const agent = ctx.agentLoop.create(SessionId('pre-request-order'))
      ctx.on('agent/request', async (_payload, next) => ({ ...await next(), provider: 'mock', model: 'mock' }))
      let attempts = 0
      ctx.on('agent/pre-request', async ({ agent: subject, turn, step, signal }) => {
        expect(subject).toBe(agent)
        expect({ turn, step }).toEqual({ turn: 1, step: 1 })
        expect(signal.aborted).toBe(false)
        expect(subject.session.requestHeader()?.config).toMatchObject({ provider: 'mock', model: 'mock' })
        expect(subject.session.requestContext()).toMatchObject({ provider: 'mock', model: 'mock' })
        attempts += 1
        await Promise.resolve()
        subject.session.append('user/message', message(`attempt context ${attempts}`), { surfaceOp: 'append' })
      })
      ctx.on('agent/request-error', async () => ({ kind: 'retry' as const }))

      agent.followup(message('go'))
      await agent.whenIdle()

      expect(attempts).toBe(2)
      expect(adapter.requests).toHaveLength(2)
      expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('attempt context 1')
      expect(JSON.stringify(adapter.requests[0]?.messages)).not.toContain('attempt context 2')
      expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('attempt context 2')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each(['cancel', 'throw'] as const)('does not dispatch or recover after a pre-request %s', async (failure) => {
    const adapter = new MockAdapter([textResponse('unused')])
    const ctx = await harness(adapter)
    try {
      const agent = ctx.agentLoop.create(SessionId(`pre-request-${failure}`), { provider: 'mock', model: 'mock' })
      let recoveries = 0
      ctx.on('agent/pre-request', ({ agent: subject }) => {
        if (failure === 'cancel') subject.cancel({ kind: 'user' })
        else throw new LlmError('pre-request failed', 'MIDDLEWARE')
      })
      ctx.on('agent/request-error', async () => { recoveries += 1 })

      agent.followup(message('go'))
      await agent.whenIdle()

      expect(adapter.requests).toHaveLength(0)
      expect(recoveries).toBe(0)
      expect(agent.session.events.at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: failure === 'cancel' ? 'aborted' : 'error' } },
      })
      expect(agent.session.events.filter(event => event.type === 'step/end')).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
