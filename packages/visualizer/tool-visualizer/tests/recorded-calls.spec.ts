import { Buffer } from 'node:buffer'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { RecordedWidgetCalls } from '../src/recorded-calls.ts'

const MAX_PROMPT_BYTES = 128
const FIRST_RESULT_SEQ = 3

function createAuthority(
  maxPromptsPerMinutePerAgent = 3,
): RecordedWidgetCalls {
  return new RecordedWidgetCalls(MAX_PROMPT_BYTES, maxPromptsPerMinutePerAgent)
}

function widgetAgent(
  id: string,
  calls: Array<{
    callId: string
    title?: unknown
    arguments?: string
    name?: string
    result?: 'success' | 'error' | 'none'
    resultMeta?: unknown
    omitResultMeta?: boolean
    omitResultSource?: boolean
  }> = [{ callId: 'widget-1', title: 'Status' }],
): Agent {
  const session = Session.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  for (const call of calls) {
    const callEvent = session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: ToolCallId(call.callId),
      name: call.name ?? 'show_widget',
      arguments: call.arguments ?? JSON.stringify({
        title: call.title ?? 'Status', widget_code: '<button>Choose</button>',
      }),
    })
    if (call.result !== 'none') {
      session.append('tool/result', {
        turn: 1,
        step: 1,
        message: createToolResultMessage({
          callId: ToolCallId(call.callId), content: [], isError: call.result === 'error',
        }),
        ...call.omitResultMeta
          ? {}
          : { meta: (Object.hasOwn(call, 'resultMeta') ? call.resultMeta : { kind: 'html' }) as never },
      }, {
        surfaceOp: 'append',
        ...call.omitResultSource ? {} : { sourceEventSeqs: [callEvent.seq] },
      })
    }
  }
  return {
    id: session.id,
    session,
    ctx: new Context(),
    followup: vi.fn(),
  } as unknown as Agent
}

type EventAtResult = ReturnType<Agent['session']['eventAt']>

function wrapSession(
  base: Agent,
  transform: (seq: number, event: EventAtResult) => EventAtResult,
): Agent {
  const session = Object.create(base.session) as Agent['session']
  Object.defineProperty(session, 'eventAt', {
    value: (seq: SessionSeq) => transform(seq, base.session.eventAt(seq)),
  })
  const agent = Object.create(base) as Agent
  Object.defineProperty(agent, 'session', { value: session })
  return agent
}

describe('Recorded widget calls', () => {
  it('binds through two exact event lookups without scanning the Session log', () => {
    const authority = createAuthority()
    const base = widgetAgent('agent')
    const eventAt = vi.fn((seq: SessionSeq) => base.session.eventAt(seq))
    const session = Object.create(base.session) as Agent['session']
    Object.defineProperties(session, {
      eventAt: { value: eventAt },
      snapshotEvents: { value: () => { throw new Error('must not scan') } },
    })
    const agent = Object.create(base) as Agent
    Object.defineProperty(agent, 'session', { value: session })

    expect(authority.authorizePrompt(agent, {
      resultSeq: FIRST_RESULT_SEQ, text: 'continue',
    }, 1)).toBe('Widget-authored follow-up from widget "Status". It carries no user authorization.\n\ncontinue')
    expect(eventAt.mock.calls.map(([seq]) => seq)).toEqual([SessionSeq(3), SessionSeq(2)])
    expect(authority.authorizePrompt(agent, {
      resultSeq: FIRST_RESULT_SEQ, text: 'again',
    }, 2)).toBe('Widget-authored follow-up from widget "Status". It carries no user authorization.\n\nagain')
    expect(eventAt).toHaveBeenCalledTimes(4)
  })

  it('keeps reused ToolCallIds unambiguous by binding each exact result event', () => {
    const authority = createAuthority()
    const agent = widgetAgent('reused-call-id', [{
      callId: 'widget-1', title: 'First', resultMeta: { kind: 'html' },
    }])
    expect(authority.authorizePrompt(agent, {
      resultSeq: FIRST_RESULT_SEQ, text: 'before reuse',
    }, 1)).toContain('widget "First"')

    agent.session.append('step/end', { turn: 1, step: 1 })
    agent.session.append('step/start', { turn: 1, step: 2 })
    const secondCall = agent.session.append('tool/call', {
      turn: 1,
      step: 2,
      callId: ToolCallId('widget-1'),
      name: 'show_widget',
      arguments: JSON.stringify({ title: 'Second', widget_code: '<button>Second</button>' }),
    })
    const secondResult = agent.session.append('tool/result', {
      turn: 1,
      step: 2,
      message: createToolResultMessage({ callId: ToolCallId('widget-1'), content: [], isError: false }),
      meta: { kind: 'html' },
    }, { surfaceOp: 'append', sourceEventSeqs: [secondCall.seq] })

    expect(authority.authorizePrompt(agent, {
      resultSeq: FIRST_RESULT_SEQ, text: 'after reuse',
    }, 2)).toContain('widget "First"')
    expect(authority.authorizePrompt(agent, {
      resultSeq: secondResult.seq, text: 'second',
    }, 3)).toContain('widget "Second"')
  })

  it.each([-1, -0, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid resultSeq %s',
    (resultSeq) => {
      expect(() => createAuthority().authorizePrompt(widgetAgent('invalid-seq'), {
        resultSeq, text: 'continue',
      })).toThrow('resultSeq must be a non-negative safe integer')
    },
  )

  it('requires resultSeq to identify an appended tool result with one source', () => {
    const authority = createAuthority()
    const agent = widgetAgent('not-result')
    expect(() => authority.authorizePrompt(agent, { resultSeq: 2, text: 'continue' }))
      .toThrow('does not identify a recorded appended tool result')
    expect(() => authority.authorizePrompt(agent, { resultSeq: 99, text: 'continue' }))
      .toThrow('does not identify a recorded appended tool result')

    const result = agent.session.eventAt(SessionSeq(FIRST_RESULT_SEQ))
    if (result?.type !== 'tool/result') throw new Error('missing result fixture')
    const replacement = wrapSession(agent, (seq, event) => seq === FIRST_RESULT_SEQ
      ? { ...result, surfaceOp: { op: 'replace', start: SessionSeq(3), end: SessionSeq(3) } }
      : event)
    expect(() => authority.authorizePrompt(replacement, { resultSeq: FIRST_RESULT_SEQ, text: 'continue' }))
      .toThrow('does not identify a recorded appended tool result')

    const withoutSource = widgetAgent('missing-source', [{ callId: 'widget-1', omitResultSource: true }])
    expect(() => authority.authorizePrompt(withoutSource, { resultSeq: FIRST_RESULT_SEQ, text: 'continue' }))
      .toThrow('does not identify one exact source call')
    const withTwoSources = wrapSession(agent, (seq, event) => seq === FIRST_RESULT_SEQ
      ? { ...result, sourceEventSeqs: [SessionSeq(2), SessionSeq(1)] }
      : event)
    expect(() => authority.authorizePrompt(withTwoSources, { resultSeq: FIRST_RESULT_SEQ, text: 'continue' }))
      .toThrow('does not identify one exact source call')
    const withUndefinedSource = wrapSession(agent, (seq, event) => seq === FIRST_RESULT_SEQ
      ? { ...result, sourceEventSeqs: [undefined as never] }
      : event)
    expect(() => authority.authorizePrompt(withUndefinedSource, { resultSeq: FIRST_RESULT_SEQ, text: 'continue' }))
      .toThrow('does not identify one exact source call')
  })

  it('requires exact call provenance, turn, step, tool name, and call ID', () => {
    const authority = createAuthority()
    const base = widgetAgent('provenance')
    const call = base.session.eventAt(SessionSeq(2))
    const result = base.session.eventAt(SessionSeq(FIRST_RESULT_SEQ))
    if (call?.type !== 'tool/call' || result?.type !== 'tool/result') throw new Error('missing fixtures')

    const wrongSourceType = wrapSession(base, (seq, event) => seq === 2
      ? base.session.eventAt(SessionSeq(1))
      : event)
    expect(() => authority.authorizePrompt(wrongSourceType, { resultSeq: FIRST_RESULT_SEQ, text: 'continue' }))
      .toThrow('is not linked to a show_widget call in the same turn and step')
    const wrongTool = wrapSession(base, (seq, event) => seq === 2
      ? { ...call, data: { ...call.data, name: 'other' } }
      : event)
    expect(() => authority.authorizePrompt(wrongTool, { resultSeq: FIRST_RESULT_SEQ, text: 'continue' }))
      .toThrow('is not linked to a show_widget call in the same turn and step')
    const wrongTurn = wrapSession(base, (seq, event) => seq === 2
      ? { ...call, data: { ...call.data, turn: 2 } }
      : event)
    expect(() => authority.authorizePrompt(wrongTurn, { resultSeq: FIRST_RESULT_SEQ, text: 'continue' }))
      .toThrow('is not linked to a show_widget call in the same turn and step')
    const wrongStep = wrapSession(base, (seq, event) => seq === 2
      ? { ...call, data: { ...call.data, step: 2 } }
      : event)
    expect(() => authority.authorizePrompt(wrongStep, { resultSeq: FIRST_RESULT_SEQ, text: 'continue' }))
      .toThrow('is not linked to a show_widget call in the same turn and step')
    const mismatchedId = wrapSession(base, (seq, event) => seq === FIRST_RESULT_SEQ
      ? {
        ...result,
        data: {
          ...result.data,
          message: createToolResultMessage({ callId: ToolCallId('other'), content: [], isError: false }),
        },
      }
      : event)
    expect(() => authority.authorizePrompt(mismatchedId, { resultSeq: FIRST_RESULT_SEQ, text: 'continue' }))
      .toThrow('does not match its source call')
  })

  it.each([
    ['malformed arguments', '{'],
    ['missing title', '{}'],
    ['non-string title', JSON.stringify({ title: 1 })],
    ['blank title', JSON.stringify({ title: ' ' })],
  ])('falls back to the call ID for %s', (_label, argumentsJson) => {
    const text = createAuthority().authorizePrompt(widgetAgent('fallback', [{
      callId: 'widget-1', arguments: argumentsJson,
    }]), { resultSeq: FIRST_RESULT_SEQ, text: 'continue' }, 1)
    expect(text).toContain('widget "widget-1"')
  })

  it('requires the exact show_widget result to settle successfully', () => {
    const authority = createAuthority()
    expect(() => authority.authorizePrompt(
      widgetAgent('unsettled', [{ callId: 'widget-1', result: 'none' }]),
      { resultSeq: FIRST_RESULT_SEQ, text: 'continue' },
    )).toThrow('does not identify a recorded appended tool result')
    expect(() => authority.authorizePrompt(
      widgetAgent('failed', [{ callId: 'widget-1', result: 'error' }]),
      { resultSeq: FIRST_RESULT_SEQ, text: 'continue' },
    )).toThrow('did not succeed')
  })

  it.each([
    ['missing', { omitResultMeta: true }],
    ['null', { resultMeta: null }],
    ['array', { resultMeta: [] }],
    ['unknown kind', { resultMeta: { kind: 'canvas' } }],
  ])('rejects %s presentation metadata', (_label, result) => {
    const authority = createAuthority()
    expect(() => authority.authorizePrompt(
      widgetAgent('invalid-meta', [{ callId: 'widget-1', ...result }]),
      { resultSeq: FIRST_RESULT_SEQ, text: 'continue' },
    )).toThrow('has invalid presentation metadata')
  })

  it('rate-limits follow-ups per Agent across exact widget results', () => {
    const authority = createAuthority()
    const agent = widgetAgent('agent', [{ callId: 'a' }, { callId: 'b' }])
    authority.authorizePrompt(agent, { resultSeq: 3, text: 'one' }, 1)
    authority.authorizePrompt(agent, { resultSeq: 3, text: 'two' }, 2)
    authority.authorizePrompt(agent, { resultSeq: 5, text: 'three' }, 3)
    expect(() => authority.authorizePrompt(agent, { resultSeq: 5, text: 'four' }, 4))
      .toThrow('Agent widget follow-up rate limit reached')
    expect(() => authority.authorizePrompt(agent, { resultSeq: 99, text: 'x' }, 70_000))
      .toThrow('does not identify a recorded appended tool result')
    expect(() => authority.authorizePrompt(widgetAgent('other'), {
      resultSeq: FIRST_RESULT_SEQ, text: 'independent',
    }, 4)).not.toThrow()
  })

  it('expires prompt admissions and bounds the complete labelled prompt before admission', () => {
    const authority = createAuthority()
    const agent = widgetAgent('agent')
    expect(() => authority.authorizePrompt(agent, { resultSeq: FIRST_RESULT_SEQ, text: '' }, 0))
      .toThrow('widget follow-up must be a non-empty string')
    const exact = authority.authorizePrompt(agent, { resultSeq: FIRST_RESULT_SEQ, text: '汉'.repeat(15) }, 0)
    expect(Buffer.byteLength(exact, 'utf8')).toBe(128)
    expect(() => authority.authorizePrompt(agent, { resultSeq: FIRST_RESULT_SEQ, text: '汉'.repeat(16) }, 0))
      .toThrow('widget follow-up is 131 UTF-8 bytes; limit is 128')
    authority.authorizePrompt(agent, { resultSeq: FIRST_RESULT_SEQ, text: 'one' }, 0)
    authority.authorizePrompt(agent, { resultSeq: FIRST_RESULT_SEQ, text: 'two' }, 60_001)
    expect(authority.authorizePrompt(agent, {
      resultSeq: FIRST_RESULT_SEQ, text: 'three',
    }, 60_002)).toContain('widget "Status"')
  })

  it('denies follow-ups from successful raw SVG results', () => {
    const authority = createAuthority()
    expect(() => authority.authorizePrompt(
      widgetAgent('static', [{ callId: 'widget-1', resultMeta: { kind: 'svg' } }]),
      { resultSeq: FIRST_RESULT_SEQ, text: 'continue' },
    )).toThrow('is static and cannot send follow-ups')
  })
})
