import { setImmediate } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { bindScopeParent, createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import LocalFileReference from '@deepseek-ai/dsh-file-reference-local'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as SubagentTool from '@deepseek-ai/dsh-tool-subagent'
import Selection from '@deepseek-ai/dsh-tool-subagent/model-selection-settings'
import * as Schedule from '@deepseek-ai/dsh-schedule'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function core(persistenceRoot?: string) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  if (persistenceRoot !== undefined) await ctx.plugin(JsonlSessionPersistence, { root: persistenceRoot, compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  return ctx
}

describe('serial creation listener integrations', () => {
  it('rolls back creation when file-reference prompt installation fails', async () => {
    const ctx = await core()
    const errors: string[] = []
    ctx.logger.error = ((error: unknown) => { errors.push(String(error)) }) as typeof ctx.logger.error
    await ctx.plugin(LocalFileReference)
    try {
      await expect(ctx.agents.create({
        sessionId: SessionId('review-file-reference'),
        setup(agentCtx) {
          agentCtx.systemPrompt.section({ name: 'context:file-reference', order: 0, text: 'occupied' })
        },
      })).rejects.toThrow('context:file-reference')
      expect(errors.some(error => error.includes('context:file-reference'))).toBe(true)
      expect(ctx.agents.list()).toEqual([])
      expect(ctx.sessions.list()).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rolls back creation when a shared preset tool installation fails', async () => {
    const ctx = await core()
    const errors: string[] = []
    ctx.logger.error = ((error: unknown) => { errors.push(String(error)) }) as typeof ctx.logger.error
    await ctx.plugin(Selection)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    const preset = createScope(ctx, { preset: 'review' })
    await preset.ctx.plugin(SubagentTool, { provider: 'spawn', modelSelectionSettings: true, backgroundMode: 'continuable' })
    try {
      await expect(ctx.agents.create({
        sessionId: SessionId('review-tool'),
        setup(agentCtx) {
          const binding = bindScopeParent(scopeOf(agentCtx)!, scopeOf(preset.ctx)!)
          agentCtx.effect(() => () => { binding.dispose() })
          agentCtx.tools.register(defineContentToolFixture({ name: 'subagent', description: 'occupied', parameters: {}, execute: () => Promise.resolve([]) }))
        },
      })).rejects.toThrow('subagent')
      expect(errors.some(error => error.includes('subagent'))).toBe(true)
      expect(ctx.agents.list()).toEqual([])
      expect(ctx.sessions.list()).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('starts due Schedule work only after every creation listener finishes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-serial-schedule-'))
    roots.push(root)
    const ctx = await core(root)
    await ctx.plugin(Schedule)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const turn = Promise.withResolvers<void>()
    let turns = 0
    let created = false
    let sessionStarted = false
    ctx.on('agent/created', async () => { entered.resolve(); await release.promise; created = true })
    ctx.on('agent/session-start', () => { sessionStarted = true })
    ctx.on('session/event', (_session, event) => { if (event.type === 'turn/start') { turns += 1; turn.resolve() } })
    const creating = ctx.agents.create({
      sessionId: SessionId('review-schedule'),
      setup(_agentCtx, agent) {
        agent.session.append('schedule/change', {
          version: 1,
          operation: 'create',
          schedule: Schedule.createAfterScheduleRecord(Schedule.ScheduleId('schedule-1'), 'due reminder', 1, Date.now() - 2_000),
        })
      },
    })
    try {
      await entered.promise
      // A full event-loop turn lets the due runtime run if it starts during creation.
      await setImmediate()
      expect(turns).toBe(0)
      expect(sessionStarted).toBe(false)
      release.resolve()
      await creating
      await turn.promise
      expect(created).toBe(true)
      expect(sessionStarted).toBe(true)
    } finally {
      release.resolve()
      await creating
      await ctx.fiber.dispose()
    }
  })
})
