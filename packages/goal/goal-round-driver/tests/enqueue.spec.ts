import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import GoalService from '@deepseek-ai/dsh-goal'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import * as goalDriver from '../src/index.ts'
import { awaitGoalRoundEnqueue } from '../src/enqueue.ts'

// Consumer-side protocol fixtures also run against the pre-extension driver.
// They deliberately do not import the implementation's outcome constructors.
type CommitResult = { kind: 'enqueued'; messageId: UserMessage['id'] } | { kind: 'not_enqueued' }
type EnqueueResult = CommitResult | { kind: 'outcome_unknown' }
interface EnqueueRequest {
  agent: Agent
  message: UserMessage
  signal: AbortSignal
  commit: () => CommitResult
}
type Enqueue = (request: EnqueueRequest) => Promise<EnqueueResult>

/** Record actual loop requests while replacing only the external model. */
class ScriptedModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Scripted turn finished.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface PendingEnqueue {
  request: EnqueueRequest
  resolve: (result: EnqueueResult) => void
  reject: (error: Error) => void
}

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** Mount the real services with a controllable external admission boundary. */
async function harness(options: { enqueue?: Enqueue; timeoutMs?: number; native?: boolean } = {}) {
  const ctx = new Context()
  const pending: PendingEnqueue[] = []
  const calls: EnqueueRequest[] = []
  let closing = false
  cleanups.push(async () => {
    closing = true
    // Resolve test-owned barriers even after an assertion fails, before disposing
    // the real driver. Dedicated teardown tests exercise unresolved providers.
    for (const call of pending) call.resolve({ kind: 'not_enqueued' })
    await ctx.fiber.dispose()
  })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(GoalService)
  const enqueue: Enqueue = async (request) => {
    calls.push(request)
    if (closing) return { kind: 'not_enqueued' }
    if (options.enqueue !== undefined) return options.enqueue(request)
    const gate = Promise.withResolvers<EnqueueResult>()
    pending.push({ request, resolve: gate.resolve, reject: gate.reject })
    return gate.promise
  }
  if (!options.native) ctx.provide('goalRoundEnqueue', { protocolVersion: 1, enqueue })
  const driver = options.native
    ? await ctx.plugin(goalDriver)
    : await ctx.plugin(goalDriver, { enqueueMode: 'external', enqueueTimeoutMs: options.timeoutMs ?? 1000 })
  await ctx.plugin(AgentLoop, { agents: [] })
  const model = new ScriptedModel()
  ctx.llm.registerAdapter(['enqueue-scripted'], model)
  const handle = await ctx.agents.create({
    sessionId: SessionId(`enqueue-test-${crypto.randomUUID()}`),
    agentOptions: { provider: 'enqueue-scripted', model: 'scripted' },
  })
  const { agent } = handle
  const inserted: UserMessage[] = []
  ctx.on('agent/inbox/inserted', ({ agent: subject, message }) => {
    if (subject === agent) inserted.push(message)
  })
  return { ctx, driver, handle, agent, model, pending, calls, inserted }
}

type Harness = Awaited<ReturnType<typeof harness>>

/** Wait for an observable effect, with a bound shorter than admission expiry. */
async function eventually(assertion: () => void): Promise<void> {
  await vi.waitFor(assertion, { timeout: 500, interval: 5 })
}

/** Allow queued microtasks and loop turns to expose a forbidden retry. */
async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve) })
  }
}

function automaticMessages(test: Harness) {
  return test.agent.session.events.filter(event => event.type === 'user/message')
    .filter(event => event.data.source.kind === 'goal' && event.data.source.round > 0)
}

function expectNoTurn(test: Harness): void {
  expect(test.agent.session.events.filter(event => event.type === 'turn/start')).toEqual([])
  expect(automaticMessages(test)).toEqual([])
  expect(test.model.requests).toEqual([])
  expect(test.agent.inbox.nextTurn).toEqual([])
  expect(test.inserted.filter(message => message.source.kind === 'goal' && message.source.round > 0)).toEqual([])
}

async function firstPending(test: Harness): Promise<PendingEnqueue> {
  test.ctx.goals.create(test.agent, { objective: 'Verify the exact queued round', maxGoalRounds: 1 })
  await eventually(() => { expect(test.pending).toHaveLength(1) })
  return test.pending[0]!
}

describe('awaited external goal enqueue', () => {
  it('keeps the standalone native mode working without an external provider', async () => {
    const test = await harness({ native: true })
    test.ctx.goals.create(test.agent, { objective: 'Native standalone continuation', maxGoalRounds: 1 })
    await eventually(() => { expect(test.ctx.goals.get(test.agent)?.phase).toBe('blocked') })

    expect(test.model.requests).toHaveLength(1)
    expect(automaticMessages(test)).toHaveLength(1)
    expect(test.ctx.goals.get(test.agent)?.roundsStarted).toBe(1)
    expect(test.calls).toEqual([])
  })

  it('does not insert or start a turn while external admission is awaiting a receipt', async () => {
    const test = await harness()
    const call = await firstPending(test)
    await settle()

    expect(call.request.agent).toBe(test.agent)
    expect(call.request.signal.aborted).toBe(false)
    expect(test.agent.status).toBe('idle')
    expect(test.ctx.goals.get(test.agent)).toMatchObject({ roundsStarted: 0, phase: 'active', activation: 'armed' })
    expectNoTurn(test)
    expect(test.calls).toHaveLength(1)
  })

  it('commits the original native message exactly once even if the provider calls commit twice', async () => {
    const test = await harness()
    const call = await firstPending(test)
    const original = structuredClone(call.request.message)
    const goal = test.ctx.goals.get(test.agent)!
    expect(original.source).toEqual({ kind: 'goal', goalId: goal.id, revision: 1, round: 1 })
    expect(original.content).toHaveLength(1)
    const block = original.content[0]
    if (block?.type !== 'text') throw new Error('Expected one text prompt')
    expect(block.text).toContain('Objective: "Verify the exact queued round"\nRound: 1/1')

    const followup = vi.spyOn(test.agent, 'followup')
    const first = call.request.commit()
    const duplicate = call.request.commit()
    expect(first).toEqual({ kind: 'enqueued', messageId: original.id })
    if (duplicate.kind === 'enqueued') expect(duplicate.messageId).toBe(original.id)
    call.resolve(first)
    await eventually(() => { expect(test.ctx.goals.get(test.agent)?.phase).toBe('blocked') })

    const inserted = test.inserted.filter(message => message.id === original.id)
    expect(inserted).toHaveLength(1)
    expect(followup).toHaveBeenCalledExactlyOnceWith(call.request.message)
    expect(followup.mock.calls[0]?.[0]).toBe(call.request.message)
    expect(inserted[0]).toEqual(original)
    const admitted = automaticMessages(test)
    expect(admitted).toHaveLength(1)
    expect(admitted[0]?.data).toMatchObject(original)
    expect(test.ctx.goals.get(test.agent)?.roundsStarted).toBe(1)
    expect(test.model.requests).toHaveLength(1)
  })

  it('invalidates an edited reservation without charging a round to the old revision', async () => {
    const test = await harness()
    const old = await firstPending(test)
    const goal = test.ctx.goals.get(test.agent)!
    test.ctx.goals.edit(test.agent, goal, { objective: 'Only the new revision may run' })
    await eventually(() => { expect(old.request.signal.aborted).toBe(true) })

    expect(old.request.commit()).toEqual({ kind: 'not_enqueued' })
    old.resolve({ kind: 'not_enqueued' })
    await eventually(() => { expect(test.pending).toHaveLength(2) })
    expectNoTurn(test)
    expect(test.ctx.goals.get(test.agent)?.roundsStarted).toBe(0)
    const fresh = test.pending[1]!
    expect(fresh.request.message.source).toEqual({ kind: 'goal', goalId: goal.id, revision: 2, round: 1 })
    const result = fresh.request.commit()
    expect(result).toEqual({ kind: 'enqueued', messageId: fresh.request.message.id })
    fresh.resolve(result)
    await eventually(() => { expect(test.ctx.goals.get(test.agent)?.phase).toBe('blocked') })
    expect(test.model.requests).toHaveLength(1)
    expect(automaticMessages(test).map(event => event.data.source)).toEqual([
      { kind: 'goal', goalId: goal.id, revision: 2, round: 1 },
    ])
  })

  it.each(['pause', 'block', 'complete', 'cancel'] as const)(
    'rejects a late commit after %s while admission is pending',
    async (operation) => {
      const test = await harness()
      const call = await firstPending(test)
      const goal = test.ctx.goals.get(test.agent)!
      if (operation === 'pause') test.ctx.goals.pause(test.agent, goal)
      if (operation === 'block') test.ctx.goals.block(test.agent, goal, { code: 'test-owner-block', message: 'Owner stopped this work.' })
      if (operation === 'complete') test.ctx.goals.complete(test.agent, goal)
      if (operation === 'cancel') {
        expect(test.agent.status).toBe('idle')
        test.agent.cancel({ kind: 'user' })
      }
      await eventually(() => { expect(call.request.signal.aborted).toBe(true) })
      expect(call.request.commit()).toEqual({ kind: 'not_enqueued' })
      call.resolve({ kind: 'not_enqueued' })
      await settle()

      expectNoTurn(test)
      expect(test.ctx.goals.get(test.agent)).toMatchObject({ roundsStarted: 0, activation: 'disarmed' })
      if (operation === 'pause' || operation === 'cancel') expect(test.ctx.goals.get(test.agent)?.phase).toBe('paused')
      if (operation === 'block') expect(test.ctx.goals.get(test.agent)?.phase).toBe('blocked')
      if (operation === 'complete') expect(test.ctx.goals.get(test.agent)?.phase).toBe('complete')
      expect(test.calls).toHaveLength(1)
    },
  )

  it('lets competing ordinary input run while preventing the old pending round from joining it', async () => {
    const test = await harness()
    const call = await firstPending(test)
    const human = createUserMessage({ content: [{ type: 'text', text: 'The ordinary prompt has its own turn.' }], source: { kind: 'user' } })
    test.agent.followup(human)
    await eventually(() => { expect(test.model.requests).toHaveLength(1) })
    await test.agent.whenIdle()
    await eventually(() => { expect(call.request.signal.aborted).toBe(true) })

    expect(call.request.commit()).toEqual({ kind: 'not_enqueued' })
    call.resolve({ kind: 'not_enqueued' })
    await settle()
    expect(automaticMessages(test)).toEqual([])
    expect(test.agent.session.events.filter(event => event.type === 'user/message' && event.data.id === human.id)).toHaveLength(1)
    expect(test.model.requests).toHaveLength(1)
    expect(test.ctx.goals.get(test.agent)?.roundsStarted).toBe(0)
  })

  it.each(['agent disposal', 'driver unload'] as const)('aborts pending admission and bounds %s even when the provider never settles', async (operation) => {
    const test = await harness({ timeoutMs: 80 })
    const call = await firstPending(test)
    let disposed = false
    const disposal = Promise.resolve(operation === 'agent disposal' ? test.handle.dispose() : test.driver.dispose())
      .then(() => { disposed = true })
    await eventually(() => { expect(call.request.signal.aborted).toBe(true) })
    await eventually(() => { expect(disposed).toBe(true) })
    await disposal

    expect(call.request.commit()).toEqual({ kind: 'not_enqueued' })
    call.resolve({ kind: 'not_enqueued' })
    await settle()
    expectNoTurn(test)
    expect(test.calls).toHaveLength(1)
    if (operation === 'agent disposal') expect(test.ctx.agents.get(test.agent.id)).toBeUndefined()
    else expect(test.ctx.goals.get(test.agent)).toMatchObject({ activation: 'disarmed', roundsStarted: 0 })
  })

  it.each(['not_enqueued', 'outcome_unknown', 'rejection'] as const)('disarms without retry after provider %s', async (outcome) => {
    const test = await harness()
    const call = await firstPending(test)
    if (outcome === 'rejection') call.reject(new Error('Admission transport rejected before its receipt.'))
    else call.resolve({ kind: outcome })
    await eventually(() => { expect(test.ctx.goals.get(test.agent)?.activation).toBe('disarmed') })
    await settle()

    expectNoTurn(test)
    expect(test.ctx.goals.get(test.agent)?.roundsStarted).toBe(0)
    expect(test.calls).toHaveLength(1)
    expect(call.request.commit()).toEqual({ kind: 'not_enqueued' })
  })

  it('expires a provider that never replies and rejects its late commit without retry', async () => {
    const test = await harness({ timeoutMs: 80 })
    const call = await firstPending(test)
    await eventually(() => { expect(call.request.signal.aborted).toBe(true) })
    await eventually(() => { expect(test.ctx.goals.get(test.agent)?.activation).toBe('disarmed') })

    expect(call.request.commit()).toEqual({ kind: 'not_enqueued' })
    call.resolve({ kind: 'not_enqueued' })
    await settle()
    expectNoTurn(test)
    expect(test.ctx.goals.get(test.agent)?.roundsStarted).toBe(0)
    expect(test.calls).toHaveLength(1)
  })

  it.each(['outcome_unknown', 'rejection', 'timeout'] as const)('does not enqueue again after commit succeeds but its admission receipt is lost by %s', async (loss) => {
    const test = await harness({ timeoutMs: 80 })
    test.ctx.goals.create(test.agent, { objective: 'Only one accepted round despite a lost response', maxGoalRounds: 3 })
    await eventually(() => { expect(test.pending).toHaveLength(1) })
    const call = test.pending[0]!
    expect(call.request.commit()).toEqual({ kind: 'enqueued', messageId: call.request.message.id })
    await eventually(() => { expect(test.model.requests).toHaveLength(1) })
    await test.agent.whenIdle()
    if (loss === 'outcome_unknown') call.resolve({ kind: 'outcome_unknown' })
    if (loss === 'rejection') call.reject(new Error('Receipt lost after native enqueue.'))
    await eventually(() => { expect(test.ctx.goals.get(test.agent)?.activation).toBe('disarmed') })
    await settle()

    expect(test.model.requests).toHaveLength(1)
    expect(automaticMessages(test)).toHaveLength(1)
    expect(test.ctx.goals.get(test.agent)?.roundsStarted).toBe(1)
    expect(test.calls).toHaveLength(1)
    call.request.commit()
    call.resolve({ kind: 'outcome_unknown' })
    await settle()
    expect(test.inserted.filter(message => message.id === call.request.message.id)).toHaveLength(1)
    expect(test.model.requests).toHaveLength(1)
  })
})


describe('external owner readback and configuration controls', () => {
  it('rechecks authoritative revision at commit even if no mutation notification was observed', async () => {
    const test = await harness()
    const call = await firstPending(test)
    const goal = test.ctx.goals.get(test.agent)!
    const read = vi.spyOn(test.ctx.goals, 'get').mockReturnValue({ ...goal, revision: goal.revision + 1 })
    expect(call.request.commit()).toEqual({ kind: 'not_enqueued' })
    read.mockRestore()
    call.resolve({ kind: 'not_enqueued' })
    await settle()
    expectNoTurn(test)
  })

  it('cancellation following a synchronous owner stop does not rewrite that phase', async () => {
    const test = await harness()
    const call = await firstPending(test)
    test.ctx.goals.complete(test.agent, test.ctx.goals.get(test.agent)!)
    test.agent.cancel({ kind: 'user' })
    call.resolve({ kind: 'not_enqueued' })
    await settle()
    expect(test.ctx.goals.get(test.agent)?.phase).toBe('complete')
    expectNoTurn(test)
  })

  it('direct mounting retains standalone defaults and rejects invalid external wait bounds', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(GoalService)
    expect(() => { goalDriver.apply(ctx, { enqueueTimeoutMs: 0 }) }).toThrow('Invalid')
    goalDriver.apply(ctx)
    expect(ctx.goalRoundDriver).toEqual({ protocolVersion: 1, enqueueMode: 'native' })
    await ctx.fiber.dispose()
  })

  it('missing provider and already aborted admission are definite zero-enqueue controls', async () => {
    const test = await harness({ native: true })
    const controller = new AbortController()
    const message = createUserMessage({ content: [], source: { kind: 'user' } })
    const commit = vi.fn(() => ({ kind: 'not_enqueued' as const }))
    const request = { agent: test.agent, message, signal: controller.signal, commit }
    expect(await awaitGoalRoundEnqueue(test.ctx, request, controller, 100)).toEqual({ kind: 'not_enqueued' })
    const enqueue = vi.fn(async () => ({ kind: 'not_enqueued' as const }))
    test.ctx.provide('goalRoundEnqueue', { protocolVersion: 1, enqueue })
    controller.abort()
    expect(await awaitGoalRoundEnqueue(test.ctx, request, controller, 100)).toEqual({ kind: 'not_enqueued' })
    expect(enqueue).not.toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()
  })
})
