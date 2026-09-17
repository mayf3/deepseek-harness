/** Sign-out impact reads prepared providers rather than configured routes. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AccountController } from '../src/index.ts'

it('reports only currently prepared account-token tasks', async () => {
  const ctx = new Context()
  const active: Array<Pick<Agent, 'activeProvider'>> = []
  // This query only consumes the registry list and each agent's prepared provider.
  ctx.provide('agents')
  ctx.set('agents', { list: () => active } as Context['agents'])
  const controller = new AccountController(ctx)
  try {
    expect(controller.hasRunningAccountTasks()).toBe(false)
    active.push({ activeProvider: undefined }, { activeProvider: 'deepseek-official' })
    expect(controller.hasRunningAccountTasks()).toBe(false)
    active.push({ activeProvider: 'deepseek-account' })
    expect(controller.hasRunningAccountTasks()).toBe(true)
    active.pop()
    expect(controller.hasRunningAccountTasks()).toBe(false)
  } finally { await ctx.fiber.dispose() }
})
