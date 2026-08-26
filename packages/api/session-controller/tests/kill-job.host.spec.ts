import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobId, JobOutcome } from '@deepseek-ai/dsh-jobs'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { TypertRemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it } from 'vitest'
import type { ApiSessionAgentController } from '../src/agent.ts'
import { SessionCommandController } from '../src/commands.ts'

function producer(label = 'sleep 60') {
  let settle!: (outcome: JobOutcome) => void
  const cancels: (string | undefined)[] = []
  const spec = {
    kind: 'bash' as const,
    label,
    run: () => ({
      cancel: (reason?: string) => { cancels.push(reason) },
      done: new Promise<JobOutcome>((resolve) => { settle = resolve }),
    }),
  }
  return { spec, cancels, settle: (outcome: JobOutcome) => { settle(outcome) } }
}

async function harness(withRegistry = true): Promise<{
  ctx: Context
  session: Session
  agent: Agent
  commands: SessionCommandController
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  if (withRegistry) {
    await ctx.plugin(LocalJobRegistry)
    ctx.jobs.attachController('kill-job-test')
  }
  const session = ctx.sessions.create()
  const agent = {
    id: session.id,
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx,
  } as Agent
  ctx.agents.register(agent)
  // killJob touches only the registry and the live-agent lookup, so the
  // resolver-owning agents controller stays out of these commands.
  const commands = new SessionCommandController(ctx, {} as ApiSessionAgentController, process.cwd())
  return { ctx, session, agent, commands }
}

function failureCode(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    if (error instanceof TypertRemoteFailure) return error.failure.code
    throw error
  }
  throw new Error('expected a TypertRemoteFailure')
}

describe('session.killJob', () => {
  it('kills an owned running job without claiming the terminal report', async () => {
    const { ctx, session, agent, commands } = await harness()
    const task = producer('pnpm run watch')
    const id = ctx.jobs.start({ ...task.spec, owner: agent })

    expect(commands.killJob({ sessionId: session.id, jobId: id })).toEqual({ outcome: 'requested' })
    expect(task.cancels).toEqual(['cancelled by the user'])
    // The unclaimed report is the whole point: the completion notice stays due.
    expect(ctx.jobs.get(id, agent)).toMatchObject({ status: 'stopping', reported: false })
  })

  it('reports an already-finished job instead of failing', async () => {
    const { ctx, session, agent, commands } = await harness()
    const task = producer()
    const id = ctx.jobs.start({ ...task.spec, owner: agent })
    task.settle({ status: 'completed', detail: 'exit code: 0' })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(commands.killJob({ sessionId: session.id, jobId: id })).toEqual({ outcome: 'already-finished' })
    expect(ctx.jobs.get(id, agent).reported).toBe(false)
  })

  it('kills an unowned job from a session without a live agent', async () => {
    const { ctx, commands } = await harness()
    const task = producer('unowned work')
    const id = ctx.jobs.start(task.spec)
    const cold = ctx.sessions.create()

    expect(commands.killJob({ sessionId: cold.id, jobId: id })).toEqual({ outcome: 'requested' })
  })

  it('rejects an unknown job id as job-not-found', async () => {
    const { session, commands } = await harness()
    expect(failureCode(() => commands.killJob({ sessionId: session.id, jobId: 'bash-99' as JobId })))
      .toBe('job-not-found')
  })

  it('rejects a foreign session\'s job as job-not-found', async () => {
    const { ctx, agent, commands } = await harness()
    const task = producer()
    const id = ctx.jobs.start({ ...task.spec, owner: agent })
    // The other session has no live agent, so the owned job is out of reach.
    const other = ctx.sessions.create()

    expect(failureCode(() => commands.killJob({ sessionId: other.id, jobId: id })))
      .toBe('job-not-found')
    expect(ctx.jobs.get(id, agent).status).toBe('running')
  })

  it('rejects when the composition has no job registry', async () => {
    const { session, commands } = await harness(false)
    expect(failureCode(() => commands.killJob({ sessionId: session.id, jobId: 'bash-1' as JobId })))
      .toBe('jobs-unavailable')
  })

  it('propagates a producer cancel throw instead of masking it as job-not-found', async () => {
    const { ctx, session, agent, commands } = await harness()
    const id = ctx.jobs.start({
      kind: 'bash',
      label: 'flaky cancel',
      owner: agent,
      run: () => ({
        cancel: () => { throw new Error('cancel boom') },
        done: new Promise(() => {}),
      }),
    })
    // The registry contract: a producer throw propagates with job state
    // unchanged — the command must not rewrite it into a lookup failure.
    expect(() => commands.killJob({ sessionId: session.id, jobId: id })).toThrow('cancel boom')
    expect(ctx.jobs.get(id, agent)).toMatchObject({ status: 'running', reported: false })
  })

  it('rejects a subagent-owned live session with the ownership fence', async () => {
    const { ctx, commands } = await harness()
    const child = ctx.sessions.create(undefined, { meta: { origin: 'subagent' } })
    const childAgent = {
      id: child.id,
      session: child,
      inbox: new Inbox(child, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
      status: 'idle',
      ctx,
    } as Agent
    ctx.agents.register(childAgent)
    const task = producer('child work')
    const id = ctx.jobs.start({ ...task.spec, owner: childAgent })

    expect(failureCode(() => commands.killJob({ sessionId: child.id, jobId: id })))
      .toBe('agent-busy')
    expect(ctx.jobs.get(id, childAgent).status).toBe('running')
  })
})
