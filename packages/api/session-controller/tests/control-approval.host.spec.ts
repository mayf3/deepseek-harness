import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { describe, expect, it, vi } from 'vitest'
import { SessionControlController } from '../src/control.ts'
import type {
  SessionApprovalRequest,
  SessionControlFrame,
  SessionInteractionId,
  SessionRespondRequest,
} from '../src/types.ts'

interface ControlCapture {
  readonly frames: SessionControlFrame[]
  waitFor(type: SessionControlFrame['type']): Promise<SessionControlFrame>
}

async function harness(): Promise<{ ctx: Context; control: SessionControlController }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ApprovalService)
  const control = new SessionControlController(ctx)
  await new Promise(resolve => setTimeout(resolve, 0))
  return { ctx, control }
}

function agentOf(ctx: Context): Agent {
  const session = ctx.sessions.create()
  session.append('turn/start', { turn: 1 })
  return { session } as unknown as Agent
}

function openControl(control: SessionControlController, abort: AbortController): ControlCapture {
  const frames: SessionControlFrame[] = []
  const waiters: {
    type: SessionControlFrame['type']
    resolve(frame: SessionControlFrame): void
  }[] = []
  void (async () => {
    for await (const frame of control.control(abort.signal)) {
      frames.push(frame)
      for (let index = waiters.length - 1; index >= 0; index--) {
        const waiter = waiters[index] as (typeof waiters)[number]
        if (waiter.type !== frame.type) continue
        waiters.splice(index, 1)
        waiter.resolve(frame)
      }
    }
  })()
  return {
    frames,
    waitFor: (type) => {
      const found = frames.find(frame => frame.type === type)
      if (found !== undefined) return Promise.resolve(found)
      return new Promise((resolve) => { waiters.push({ type, resolve }) })
    },
  }
}

function requestedOf(frame: SessionControlFrame): SessionApprovalRequest {
  if (frame.type !== 'approval/requested') {
    throw new Error(`expected approval/requested, got ${frame.type}`)
  }
  return frame
}

async function waitForCount(
  stream: ControlCapture,
  type: SessionControlFrame['type'],
  count: number,
): Promise<void> {
  for (let index = 0; index < 200 && stream.frames.filter(frame => frame.type === type).length < count; index++) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  expect(stream.frames.filter(frame => frame.type === type).length).toBeGreaterThanOrEqual(count)
}

function answer(
  interactionId: SessionInteractionId,
  sessionId: unknown,
  approvalId: ApprovalRequestId,
  outcome: 'allowed-once' | 'rejected',
): SessionRespondRequest {
  return {
    interactionId,
    result: { ok: true, value: { sessionId, approvalId, outcome } },
  } as SessionRespondRequest
}

describe('approval pending registry', () => {
  it('round-trips ask through requested, response, outcome, and resolved frames', async () => {
    const { ctx, control } = await harness()
    const abort = new AbortController()
    const stream = openControl(control, abort)
    const agent = agentOf(ctx)

    const asked = ctx.approval.request({ agent, toolName: 'bash', reason: 'sandbox escalation' })
    const requested = requestedOf(await stream.waitFor('approval/requested'))
    expect(requested).toMatchObject({
      toolName: 'bash',
      reason: 'sandbox escalation',
      sessionId: agent.session.id,
    })

    expect(control.respond(answer(
      requested.interactionId,
      requested.sessionId,
      requested.approvalId,
      'allowed-once',
    ))).toEqual({ accepted: true })
    await expect(asked).resolves.toBe('allowed-once')

    const resolved = await stream.waitFor('approval/resolved')
    expect(resolved).toMatchObject({ approvalId: requested.approvalId, outcome: 'allowed-once' })
    expect(control.respond(answer(
      requested.interactionId,
      requested.sessionId,
      requested.approvalId,
      'rejected',
    ))).toEqual({ accepted: false, reason: 'not-pending' })
    abort.abort()
  })

  it('replays one pending request with the same interaction id in a new baseline', async () => {
    const { ctx, control } = await harness()
    const firstAbort = new AbortController()
    const first = openControl(control, firstAbort)
    const agent = agentOf(ctx)
    const asked = ctx.approval.request({ agent, toolName: 'write' })
    const requested = requestedOf(await first.waitFor('approval/requested'))
    firstAbort.abort()

    const secondAbort = new AbortController()
    const second = openControl(control, secondAbort)
    const baseline = await second.waitFor('baseline')
    if (baseline.type !== 'baseline') throw new Error('expected baseline')
    const replayed = baseline.value.approvals[0]
    expect(replayed?.interactionId).toBe(requested.interactionId)
    expect(replayed?.approvalId).toBe(requested.approvalId)

    expect(control.respond(answer(
      requested.interactionId,
      requested.sessionId,
      requested.approvalId,
      'rejected',
    ))).toEqual({ accepted: true })
    await expect(asked).resolves.toBe('rejected')
    secondAbort.abort()
  })

  it('rejects malformed and mismatched answers, and reports unknown interactions', async () => {
    const { ctx, control } = await harness()
    const abort = new AbortController()
    const stream = openControl(control, abort)
    const agent = agentOf(ctx)
    void ctx.approval.request({ agent, toolName: 'bash' })
    const requested = requestedOf(await stream.waitFor('approval/requested'))

    expect(control.respond(answer(
      'ghost' as SessionInteractionId,
      requested.sessionId,
      requested.approvalId,
      'rejected',
    ))).toEqual({ accepted: false, reason: 'not-pending' })
    expect(control.respond({
      interactionId: requested.interactionId,
      result: { ok: false, error: { code: 'internal', message: 'x', details: {} } },
    })).toEqual({ accepted: false, reason: 'bad-response' })
    expect(control.respond(answer(
      requested.interactionId,
      requested.sessionId,
      'other-approval' as ApprovalRequestId,
      'rejected',
    ))).toEqual({ accepted: false, reason: 'bad-response' })
    expect(control.respond({
      interactionId: requested.interactionId,
      result: { ok: true, value: { nonsense: 1 } as never },
    })).toEqual({ accepted: false, reason: 'bad-response' })
    abort.abort()
  })

  it('withdraws an approval when its ask signal aborts', async () => {
    const { ctx, control } = await harness()
    const abort = new AbortController()
    const stream = openControl(control, abort)
    const agent = agentOf(ctx)
    const cancel = new AbortController()
    const asked = ctx.approval.request({ agent, toolName: 'bash', signal: cancel.signal })
    const requested = requestedOf(await stream.waitFor('approval/requested'))

    cancel.abort()
    await expect(asked).resolves.toBe('cancelled')
    expect(await stream.waitFor('approval/resolved')).toMatchObject({
      approvalId: requested.approvalId,
      outcome: 'cancelled',
    })
    expect(control.respond(answer(
      requested.interactionId,
      requested.sessionId,
      requested.approvalId,
      'allowed-once',
    ))).toEqual({ accepted: false, reason: 'not-pending' })
    abort.abort()
  })

  it('settles a pre-aborted dispatch without publishing it', async () => {
    const { ctx, control } = await harness()
    const abort = new AbortController()
    const stream = openControl(control, abort)
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    session.append('approval/asked', {
      id: 'pre-aborted' as ApprovalRequestId,
      toolName: 'bash',
    })
    const agent = { session } as unknown as Agent
    const cancelled = new AbortController()
    cancelled.abort()
    const outcome = await ctx.waterfall(
      'approval/request',
      { agent, toolName: 'bash', signal: cancelled.signal },
      () => Promise.resolve('unavailable' as const),
    )
    expect(outcome).toBe('cancelled')

    const secondAbort = new AbortController()
    const second = openControl(control, secondAbort)
    await second.waitFor('baseline')
    expect(second.frames.some(frame => frame.type === 'approval/requested')).toBe(false)
    secondAbort.abort()
    abort.abort()
    void stream
  })

  it('settles pending approvals when the controller is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { persona: '' })
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ApprovalService)
    let control!: SessionControlController
    const fiber = ctx.plugin(Object.assign((fiberCtx: Context) => {
      control = new SessionControlController(fiberCtx)
    }, { inject: ['sessions', 'agents', 'userQuestions', 'approval'] }))
    await fiber.await()
    const abort = new AbortController()
    const stream = openControl(control, abort)
    const asked = ctx.approval.request({ agent: agentOf(ctx), toolName: 'bash' })
    const requested = requestedOf(await stream.waitFor('approval/requested'))

    await fiber.dispose()
    await expect(asked).resolves.toBe('cancelled')
    expect(await stream.waitFor('approval/resolved')).toMatchObject({
      approvalId: requested.approvalId,
      outcome: 'cancelled',
    })
    abort.abort()
  })

  it('carries callId and ignores an abort after the answer settled', async () => {
    const { ctx, control } = await harness()
    const abort = new AbortController()
    const stream = openControl(control, abort)
    const agent = agentOf(ctx)
    const cancel = new AbortController()
    vi.spyOn(cancel.signal, 'removeEventListener').mockImplementation(() => {})
    const asked = ctx.approval.request({
      agent,
      toolName: 'bash',
      callId: 'call-9' as never,
      signal: cancel.signal,
    })
    const requested = requestedOf(await stream.waitFor('approval/requested'))
    expect(requested.callId).toBe('call-9')
    expect(control.respond(answer(
      requested.interactionId,
      requested.sessionId,
      requested.approvalId,
      'allowed-once',
    ))).toEqual({ accepted: true })
    await expect(asked).resolves.toBe('allowed-once')
    cancel.abort()
    expect(stream.frames.filter(frame => frame.type === 'approval/resolved')).toHaveLength(1)
    abort.abort()
  })

  it('contains an abort that wins immediately after pending registration', async () => {
    const { ctx, control } = await harness()
    void control
    let reads = 0
    const signal = {
      get aborted() { return ++reads >= 3 },
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as AbortSignal

    await expect(ctx.approval.request({
      agent: agentOf(ctx),
      toolName: 'bash',
      signal,
    })).resolves.toBe('cancelled')
  })

  it('cancels only approvals owned by a disposed Session', async () => {
    const { ctx, control } = await harness()
    const abort = new AbortController()
    const stream = openControl(control, abort)
    const first = agentOf(ctx)
    const second = agentOf(ctx)
    const firstAsk = ctx.approval.request({ agent: first, toolName: 'first' })
    const secondAsk = ctx.approval.request({ agent: second, toolName: 'second' })
    await waitForCount(stream, 'approval/requested', 2)
    const requests = stream.frames.filter(
      (frame): frame is Extract<SessionControlFrame, { type: 'approval/requested' }> => (
        frame.type === 'approval/requested'
      ),
    )

    ctx.emit('session/disposed', first.session)

    await expect(firstAsk).resolves.toBe('cancelled')
    const remaining = requests.find(request => request.sessionId === second.session.id)
    if (remaining === undefined) throw new Error('missing second approval')
    expect(control.respond(answer(
      remaining.interactionId,
      remaining.sessionId,
      remaining.approvalId,
      'allowed-once',
    ))).toEqual({ accepted: true })
    await expect(secondAsk).resolves.toBe('allowed-once')
    abort.abort()
  })

  it('pairs parallel asks by callId', async () => {
    const { ctx, control } = await harness()
    const abort = new AbortController()
    const stream = openControl(control, abort)
    const agent = agentOf(ctx)
    const askA = ctx.approval.request({ agent, toolName: 'bash', callId: 'call-a' as never })
    const askB = ctx.approval.request({ agent, toolName: 'bash', callId: 'call-b' as never })
    await waitForCount(stream, 'approval/requested', 2)
    const requests = stream.frames
      .filter((frame): frame is Extract<SessionControlFrame, { type: 'approval/requested' }> => (
        frame.type === 'approval/requested'
      ))
    const requestA = requests.find(frame => frame.callId === 'call-a')
    const requestB = requests.find(frame => frame.callId === 'call-b')
    if (requestA === undefined || requestB === undefined) throw new Error('missing parallel request')
    const askedIdByCall = new Map(agent.session.events
      .filter(event => event.type === 'approval/asked')
      .map(event => [String(event.data.callId), event.data.id]))
    expect(requestA.approvalId).toBe(askedIdByCall.get('call-a'))
    expect(requestB.approvalId).toBe(askedIdByCall.get('call-b'))

    expect(control.respond(answer(
      requestB.interactionId,
      requestB.sessionId,
      requestB.approvalId,
      'rejected',
    ))).toEqual({ accepted: true })
    expect(control.respond(answer(
      requestA.interactionId,
      requestA.sessionId,
      requestA.approvalId,
      'allowed-once',
    ))).toEqual({ accepted: true })
    await expect(askA).resolves.toBe('allowed-once')
    await expect(askB).resolves.toBe('rejected')
    abort.abort()
  })

  it('gives parallel callId-less asks distinct audit ids', async () => {
    const { ctx, control } = await harness()
    const abort = new AbortController()
    const stream = openControl(control, abort)
    const agent = agentOf(ctx)
    const askA = ctx.approval.request({ agent, toolName: 'alpha' })
    const askB = ctx.approval.request({ agent, toolName: 'beta' })
    await waitForCount(stream, 'approval/requested', 2)
    const requests = stream.frames
      .filter((frame): frame is Extract<SessionControlFrame, { type: 'approval/requested' }> => (
        frame.type === 'approval/requested'
      ))
    const requestA = requests.find(frame => frame.toolName === 'alpha')
    const requestB = requests.find(frame => frame.toolName === 'beta')
    if (requestA === undefined || requestB === undefined) throw new Error('missing parallel request')
    expect(requestA.approvalId).not.toBe(requestB.approvalId)

    expect(control.respond(answer(
      requestA.interactionId,
      requestA.sessionId,
      requestA.approvalId,
      'allowed-once',
    ))).toEqual({ accepted: true })
    expect(control.respond(answer(
      requestB.interactionId,
      requestB.sessionId,
      requestB.approvalId,
      'rejected',
    ))).toEqual({ accepted: true })
    await expect(askA).resolves.toBe('allowed-once')
    await expect(askB).resolves.toBe('rejected')
    abort.abort()
  })

  it('delegates a dispatch whose only asked candidate is already decided', async () => {
    const { ctx, control } = await harness()
    void control
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    session.append('approval/asked', {
      id: 'stale-ask' as ApprovalRequestId,
      toolName: 'bash',
    })
    session.append('approval/decided', {
      id: 'stale-ask' as ApprovalRequestId,
      outcome: 'rejected',
    })
    const agent = { session } as unknown as Agent
    const outcome = await ctx.waterfall(
      'approval/request',
      { agent, toolName: 'bash' },
      () => Promise.resolve('unavailable' as const),
    )
    expect(outcome).toBe('unavailable')
  })

  it('delegates an ask with no matching audit event', async () => {
    const { ctx, control } = await harness()
    void control
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    const agent = { session } as unknown as Agent
    const outcome = await ctx.waterfall(
      'approval/request',
      { agent, toolName: 'x' },
      () => Promise.resolve('unavailable' as const),
    )
    expect(outcome).toBe('unavailable')
  })
})
