import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { SessionControlController } from '../src/control.ts'
import type {
  SessionControlFrame,
  SessionQuestionRequest,
  SessionRespondRequest,
} from '../src/types.ts'

type QuestionFrame = Extract<SessionControlFrame, { type: 'question/requested' }>

async function harness(): Promise<{ ctx: Context; control: SessionControlController }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  return { ctx, control: new SessionControlController(ctx) }
}

function agent(ctx: Context): Agent {
  const session = ctx.sessions.create()
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
  const value = { id: session.id, session, inbox, status: 'idle', ctx } as Agent
  ctx.agents.register(value)
  return value
}

function openControl(control: SessionControlController, abort: AbortController): {
  frames: SessionControlFrame[]
  waitForQuestion(): Promise<QuestionFrame>
} {
  const frames: SessionControlFrame[] = []
  let resolveQuestion!: (value: QuestionFrame) => void
  const question = new Promise<QuestionFrame>((resolve) => {
    resolveQuestion = resolve
  })
  void (async () => {
    for await (const frame of control.control(abort.signal)) {
      frames.push(frame)
      if (frame.type === 'question/requested') resolveQuestion(frame)
    }
  })()
  return { frames, waitForQuestion: () => question }
}

function answer(
  request: SessionQuestionRequest,
  selected: string[],
  custom?: string,
): SessionRespondRequest {
  const question = request.questions[0]
  if (question === undefined) throw new Error('question request is empty')
  return {
    interactionId: request.interactionId,
    result: {
      ok: true,
      value: {
        sessionId: request.sessionId,
        answer: {
          answers: [{
            id: question.id,
            selected,
            ...custom === undefined ? {} : { custom },
          }],
        },
      },
    },
  }
}

describe('question response validation', () => {
  it('rejects questions without an owning Agent', async () => {
    const { ctx } = await harness()
    await expect(ctx.userQuestions.ask({
      questions: [{ id: 'owner', question: 'Who owns this?', options: [{ label: 'Nobody' }] }],
    })).rejects.toMatchObject({ code: 'ASK_MISSING_AGENT' })
  })

  it('accepts selected options with custom text for multi-select questions', async () => {
    const { ctx, control } = await harness()
    const abort = new AbortController()
    const stream = openControl(control, abort)
    const asked = ctx.userQuestions.ask({
      agent: agent(ctx),
      questions: [{
        id: 'targets',
        question: 'Choose targets and add another',
        multiSelect: true,
        options: [{ label: 'Code' }, { label: 'Docs' }],
      }],
    })
    const request = await stream.waitForQuestion()

    expect(control.respond(answer(request, ['Code', 'Docs'], 'Release notes')))
      .toEqual({ accepted: true })
    await expect(asked).resolves.toEqual({
      answers: [{ id: 'targets', selected: ['Code', 'Docs'], custom: 'Release notes' }],
    })
    expect(stream.frames.some(item => item.type === 'question/resolved')).toBe(true)
    abort.abort()
  })

  it('keeps selected options and custom text mutually exclusive for single-select questions', async () => {
    const { ctx, control } = await harness()
    const abort = new AbortController()
    const stream = openControl(control, abort)
    const asked = ctx.userQuestions.ask({
      agent: agent(ctx),
      questions: [{
        id: 'target',
        question: 'Choose one target',
        options: [{ label: 'Code' }, { label: 'Docs' }],
      }],
    })
    const request = await stream.waitForQuestion()

    expect(control.respond(answer(request, ['Code'], 'Release notes')))
      .toEqual({ accepted: false, reason: 'bad-response' })
    expect(control.respond(answer(request, [], 'Release notes')))
      .toEqual({ accepted: true })
    await expect(asked).resolves.toEqual({
      answers: [{ id: 'target', selected: [], custom: 'Release notes' }],
    })
    abort.abort()
  })

  it('rejects malformed answers without consuming the pending question', async () => {
    const { ctx, control } = await harness()
    const abort = new AbortController()
    const stream = openControl(control, abort)
    const asked = ctx.userQuestions.ask({
      agent: agent(ctx),
      questions: [{
        id: 'target',
        question: 'Choose targets',
        multiSelect: true,
        options: [{ label: 'Code' }, { label: 'Docs' }],
      }],
    })
    const request = await stream.waitForQuestion()
    const malformed: unknown[] = [
      null,
      [],
      { sessionId: request.sessionId, answer: null },
      { sessionId: request.sessionId, answer: { answers: 'invalid' } },
      { sessionId: request.sessionId, answer: { answers: [null] } },
      { sessionId: request.sessionId, answer: { answers: [{ id: 'target', selected: [1] }] } },
      { sessionId: request.sessionId, answer: { answers: [{ id: 'target', selected: [], custom: 1 }] } },
      { sessionId: 'other', answer: { answers: [{ id: 'target', selected: [] }] } },
      { sessionId: request.sessionId, answer: { answers: [] } },
      { sessionId: request.sessionId, answer: { answers: [{ id: 'other', selected: [] }] } },
      { sessionId: request.sessionId, answer: { answers: [{ id: 'target', selected: ['Code', 'Code'] }] } },
      { sessionId: request.sessionId, answer: { answers: [{ id: 'target', selected: [], custom: '   ' }] } },
      { sessionId: request.sessionId, answer: { answers: [{ id: 'target', selected: ['Unknown'] }] } },
    ]
    expect(control.respond({
      interactionId: request.interactionId,
      result: { ok: false, error: { code: 'internal', message: 'bad', details: {} } },
    })).toEqual({ accepted: false, reason: 'bad-response' })
    for (const value of malformed) {
      expect(control.respond({
        interactionId: request.interactionId,
        result: { ok: true, value: value as never },
      })).toEqual({ accepted: false, reason: 'bad-response' })
    }

    expect(control.respond(answer(request, ['Code']))).toEqual({ accepted: true })
    await expect(asked).resolves.toEqual({ answers: [{ id: 'target', selected: ['Code'] }] })
    abort.abort()
  })

  it('accepts free-form answers when a question has no options', async () => {
    const { ctx, control } = await harness()
    const abort = new AbortController()
    const stream = openControl(control, abort)
    const asked = ctx.userQuestions.ask({
      agent: agent(ctx),
      questions: [{ id: 'detail', question: 'Provide detail' }],
    })
    const request = await stream.waitForQuestion()

    expect(control.respond(answer(request, [], 'details'))).toEqual({ accepted: true })
    await expect(asked).resolves.toEqual({
      answers: [{ id: 'detail', selected: [], custom: 'details' }],
    })
    abort.abort()
  })

  it('handles caller cancellation and races while a response is decoded', async () => {
    const { ctx, control } = await harness()
    const abort = new AbortController()
    const stream = openControl(control, abort)

    const cancelledAsk = ctx.userQuestions.ask({
      agent: agent(ctx),
      questions: [{ id: 'cancel', question: 'Cancel?', options: [{ label: 'No' }] }],
    })
    const cancelled = await stream.waitForQuestion()
    expect(control.respond({
      interactionId: cancelled.interactionId,
      result: { ok: false, error: { code: 'cancelled', message: 'cancelled', details: {} } },
    })).toEqual({ accepted: true })
    await expect(cancelledAsk).rejects.toMatchObject({ code: 'ASK_CANCELLED' })

    const raceAbort = new AbortController()
    const racedAsk = ctx.userQuestions.ask({
      agent: agent(ctx),
      signal: raceAbort.signal,
      questions: [{ id: 'race', question: 'Race?', options: [{ label: 'Yes' }] }],
    })
    const raced = await vi.waitFor(() => {
      const found = stream.frames.find(frame => frame.type === 'question/requested'
        && frame.questions[0]?.id === 'race')
      expect(found).toBeDefined()
      return found as QuestionFrame
    })
    const error = {
      get code(): string {
        raceAbort.abort()
        return 'cancelled'
      },
      message: 'cancelled',
      details: {},
    }
    expect(control.respond({
      interactionId: raced.interactionId,
      result: { ok: false, error },
    })).toEqual({ accepted: false, reason: 'not-pending' })
    await expect(racedAsk).rejects.toMatchObject({ code: 'ASK_ABORTED' })

    const answerAbort = new AbortController()
    const answerRace = ctx.userQuestions.ask({
      agent: agent(ctx),
      signal: answerAbort.signal,
      questions: [{ id: 'answer-race', question: 'Race?', options: [{ label: 'Yes' }] }],
    })
    const answerRequest = await vi.waitFor(() => {
      const found = stream.frames.find(frame => frame.type === 'question/requested'
        && frame.questions[0]?.id === 'answer-race')
      expect(found).toBeDefined()
      return found as QuestionFrame
    })
    const result = {
      ok: true as const,
      get value() {
        answerAbort.abort()
        return {
          sessionId: answerRequest.sessionId,
          answer: { answers: [{ id: 'answer-race', selected: ['Yes'] }] },
        }
      },
    }
    expect(control.respond({ interactionId: answerRequest.interactionId, result }))
      .toEqual({ accepted: false, reason: 'not-pending' })
    await expect(answerRace).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    abort.abort()
  })

  it('contains aborts before and immediately after provider registration', async () => {
    const { ctx } = await harness()
    const question = { id: 'race', question: 'Race?', options: [{ label: 'Yes' }] }
    const signalAfter = (abortedAt: number, notifyOnAdd = false): AbortSignal => {
      let reads = 0
      return {
        get aborted() { return ++reads >= abortedAt },
        addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
          if (!notifyOnAdd) return
          if (typeof listener === 'function') listener(new Event('abort'))
          else listener.handleEvent(new Event('abort'))
        },
        removeEventListener: () => {},
      } as unknown as AbortSignal
    }

    await expect(ctx.userQuestions.ask({
      agent: agent(ctx),
      signal: signalAfter(2),
      questions: [question],
    })).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    await expect(ctx.userQuestions.ask({
      agent: agent(ctx),
      signal: signalAfter(3, true),
      questions: [question],
    })).rejects.toMatchObject({ code: 'ASK_ABORTED' })
  })

  it('replays pending questions in baselines and rejects them on controller disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    let control!: SessionControlController
    const fiber = ctx.plugin(Object.assign((fiberCtx: Context) => {
      control = new SessionControlController(fiberCtx)
    }, { inject: ['sessions', 'agents', 'userQuestions'] }))
    await fiber.await()
    const firstAbort = new AbortController()
    const first = openControl(control, firstAbort)
    const asked = ctx.userQuestions.ask({
      agent: agent(ctx),
      questions: [{ id: 'pending', question: 'Pending?', options: [{ label: 'Yes' }] }],
    })
    const requested = await first.waitForQuestion()
    const secondAbort = new AbortController()
    const second = openControl(control, secondAbort)
    await vi.waitFor(() => { expect(second.frames[0]?.type).toBe('baseline') })
    const baseline = second.frames[0]
    if (baseline?.type !== 'baseline') throw new Error('missing baseline')
    expect(baseline.value.questions).toContainEqual(expect.objectContaining({
      interactionId: requested.interactionId,
    }))

    await fiber.dispose()
    await expect(asked).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    firstAbort.abort()
    secondAbort.abort()
  })

  it('cancels only questions owned by a disposed Session', async () => {
    const { ctx, control } = await harness()
    const abort = new AbortController()
    const stream = openControl(control, abort)
    const first = agent(ctx)
    const second = agent(ctx)
    const firstAsk = ctx.userQuestions.ask({
      agent: first,
      questions: [{ id: 'first', question: 'First?', options: [{ label: 'Yes' }] }],
    })
    const secondAsk = ctx.userQuestions.ask({
      agent: second,
      questions: [{ id: 'second', question: 'Second?', options: [{ label: 'Yes' }] }],
    })
    await vi.waitFor(() => {
      expect(stream.frames.filter(frame => frame.type === 'question/requested')).toHaveLength(2)
    })
    const requests = stream.frames.filter(
      (frame): frame is QuestionFrame => frame.type === 'question/requested',
    )

    ctx.emit('session/disposed', first.session)

    await expect(firstAsk).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    const remaining = requests.find(request => request.sessionId === second.session.id)
    if (remaining === undefined) throw new Error('missing second question')
    expect(control.respond(answer(remaining, ['Yes']))).toEqual({ accepted: true })
    await expect(secondAsk).resolves.toEqual({
      answers: [{ id: 'second', selected: ['Yes'] }],
    })
    abort.abort()
  })
})
