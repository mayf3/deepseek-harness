/** The `--json` run projection: ordering, coalescing, bounding, and disposal. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { LlmAttemptId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { projectJsonRun, type JsonProjectionOptions } from '../src/json-stream.ts'

afterEach(() => { vi.useRealTimers() })

interface ProjectionHarness {
  readonly lines: string[]
  readonly projection: ReturnType<typeof projectJsonRun>
  readonly agent: Agent
  readonly session: Session
  readonly parsed: () => Record<string, unknown>[]
  emitSession(event: SessionEvent): void
  emitFrame(chunk: StreamChunk): void
  emitRawSession(session: unknown, event: SessionEvent): void
  emitRawFrame(payload: { agent: Agent; frame: AssistantStreamFrame }): void
}

/** Drive the projector through a minimal Context and Agent double. */
function harness(options: JsonProjectionOptions = {}): ProjectionHarness {
  const lines: string[] = []
  const sessionListeners = new Set<(session: unknown, event: SessionEvent) => void>()
  const frameListeners = new Set<(payload: { agent: Agent; frame: AssistantStreamFrame }) => void>()
  const ctx = {
    on(name: string, handler: unknown) {
      const set = name === 'session/event' ? sessionListeners : frameListeners
      set.add(handler as never)
      return () => { set.delete(handler as never) }
    },
  } as unknown as Context
  const session = {} as Session
  const agent = { id: 'session-1', session } as unknown as Agent
  const projection = projectJsonRun(ctx, agent, {
    write: (chunk: string) => { lines.push(chunk); return true },
  }, { cwd: '/', ...options })
  const attemptId = LlmAttemptId('attempt')
  let revision = 0
  return {
    lines,
    projection,
    agent,
    session,
    parsed: () => lines.map(line => JSON.parse(line) as Record<string, unknown>),
    emitSession: (event) => { for (const listener of sessionListeners) listener(session, event) },
    emitFrame: (chunk) => {
      revision += 1
      const frame: AssistantStreamFrame = {
        type: 'chunk', attemptId, revision, index: 0, time: 0, chunk,
      }
      for (const listener of frameListeners) listener({ agent, frame })
    },
    emitRawSession: (rawSession, event) => { for (const listener of sessionListeners) listener(rawSession, event) },
    emitRawFrame: (payload) => { for (const listener of frameListeners) listener(payload) },
  }
}

describe('--json projection', () => {
  it('opens with the session event before any observed event', () => {
    const test = harness()
    expect(test.parsed()).toEqual([{ type: 'session', sessionId: 'session-1', cwd: '/' }])
  })

  it('coalesces consecutive same-kind deltas and flushes them before a later event', () => {
    const test = harness({ coalesceMs: 10_000 })
    test.emitFrame({ type: 'text-delta', index: 0, text: 'an' })
    test.emitFrame({ type: 'text-delta', index: 0, text: 'swer' })
    test.emitFrame({ type: 'reasoning-delta', index: 0, text: 'think' })
    test.emitFrame({ type: 'text-delta', index: 0, text: '!' })
    test.emitSession({ type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"a":1}' } } as unknown as SessionEvent)
    expect(test.parsed().map(event => event.type)).toEqual(['session', 'text', 'thinking', 'text', 'tool_call'])
    expect(test.parsed()[1]).toEqual({ type: 'text', text: 'answer' })
    expect(test.parsed()[3]).toEqual({ type: 'text', text: '!' })
    expect(test.parsed()[4]).toMatchObject({ type: 'tool_call', callId: 'c1', tool: 'bash', input: { a: 1 } })
  })

  it('flushes a buffered delta when the byte cap is reached', () => {
    const test = harness({ coalesceMs: 10_000, coalesceBytes: 4 })
    test.emitFrame({ type: 'text-delta', index: 0, text: 'abc' })
    expect(test.lines).toHaveLength(1)
    test.emitFrame({ type: 'text-delta', index: 0, text: 'd' })
    expect(test.parsed().map(event => event.type)).toEqual(['session', 'text'])
    expect(test.parsed()[1]).toEqual({ type: 'text', text: 'abcd' })
  })

  it('flushes a buffered delta on the coalescing timer', () => {
    vi.useFakeTimers()
    const test = harness({ coalesceMs: 100 })
    test.emitFrame({ type: 'text-delta', index: 0, text: 'later' })
    expect(test.lines).toHaveLength(1)
    vi.advanceTimersByTime(100)
    expect(test.parsed().map(event => event.type)).toEqual(['session', 'text'])
  })

  it('bounds every long string and flags the event once', () => {
    const test = harness({ coalesceMs: 10_000, maxStringBytes: 16 })
    test.emitFrame({ type: 'text-delta', index: 0, text: 'abcdefghijklmnopqrst' })
    test.emitSession({
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'x'.repeat(40) }) },
    } as unknown as SessionEvent)
    const events = test.parsed()
    expect(events[1]).toEqual({ type: 'text', text: 'abcdefghijklmnop', truncated: true })
    expect(events[2]).toMatchObject({ type: 'tool_call', truncated: true })
    expect(events[2]?.input).toEqual({ command: 'x'.repeat(16) })
  })

  it('ignores events from other Sessions and Agents', () => {
    const test = harness({ coalesceMs: 10_000 })
    test.emitRawSession({}, { type: 'turn/start', data: { turn: 1 } } as unknown as SessionEvent)
    test.emitRawFrame({
      agent: { id: 'other', session: {} } as unknown as Agent,
      frame: { type: 'chunk', attemptId: LlmAttemptId('other'), revision: 1, index: 0, time: 0, chunk: { type: 'text-delta', index: 0, text: 'foreign' } },
    })
    test.projection.finish('mine')
    expect(test.parsed().map(event => event.type)).toEqual(['session', 'final'])
  })

  it('reports tool results as completed or errored and keeps the final event last', () => {
    const test = harness({ coalesceMs: 10_000 })
    test.emitSession({
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: {
          content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'a.txt' }], isError: false }],
        },
      },
    } as unknown as SessionEvent)
    test.emitSession({
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: {
          content: [{ type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: 'boom' }], isError: true }],
        },
      },
    } as unknown as SessionEvent)
    test.projection.finish('done')
    const events = test.parsed()
    expect(events[1]).toEqual({ type: 'tool_result', callId: 'c1', status: 'completed', result: 'a.txt' })
    expect(events[2]).toEqual({ type: 'tool_result', callId: 'c2', status: 'error', result: 'boom' })
    expect(events.at(-1)).toEqual({ type: 'final', text: 'done' })
  })

  it('attaches step usage to the step_end status and drops buffered deltas on dispose', () => {
    const test = harness({ coalesceMs: 10_000 })
    test.emitSession({
      type: 'assistant/message',
      data: {
        stream: [],
        turn: 1,
        step: 1,
        usage: { inputTokens: 3, outputTokens: 4 },
        message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'm' } },
      },
    } as unknown as SessionEvent)
    test.emitSession({ type: 'step/end', data: { turn: 1, step: 1 } } as unknown as SessionEvent)
    expect(test.parsed()[1]).toEqual({ type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 3, outputTokens: 4 } })

    test.emitFrame({ type: 'text-delta', index: 0, text: 'dropped' })
    test.projection.dispose()
    test.projection.finish('ignored')
    expect(test.parsed().map(event => event.type)).toEqual(['session', 'status'])
  })
})
