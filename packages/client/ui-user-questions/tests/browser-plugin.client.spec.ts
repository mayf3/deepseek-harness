/** Scoped Remote Event wiring for the browser question consumer. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import type { PendingWait, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { QuestionComposer } from '../src/client/QuestionComposer.tsx'
import { PendingQuestion } from '../src/client/contract/slots.ts'
import { apply, inject } from '../src/client/index.ts'

const SESSION_ID = 'session-question' as SessionId
const ANSWER = { answers: [{ id: 'mode', selected: ['Fast'] }] }
const QUESTIONS = [{ id: 'mode', question: 'Choose a mode' }]

type QuestionRequest = {
  questions: typeof QUESTIONS
  signal?: AbortSignal
}
type QuestionNext = () => Promise<typeof ANSWER>
type QuestionListener = (
  this: Context,
  request: QuestionRequest,
  next: QuestionNext,
) => Promise<typeof ANSWER>

async function bench(declare = true) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  if (declare) {
    slots.register(
      { name: 'root', children: { 'conversation.composer': { kind: 'chain', scope: 'session' } } } as never,
      () => null,
    )
  }
  ctx.provide('locale', new LocaleRuntime(ctx))
  const owner = ctx.extend()
  const scopeOf = vi.fn((candidate: Context) => candidate === owner ? SESSION_ID : undefined)
  ctx.provide('sessions', { scopeOf } as never)

  let presented: PendingWait<'question'> | undefined
  const remove = vi.fn(() => {
    presented?.markSettled()
    presented = undefined
  })
  const present = vi.fn((wait: PendingWait<'question'>) => {
    presented = wait
    return remove
  })
  ctx.provide('conversation', {
    pendingInteractions: {
      present,
      statuses: { getSnapshot: () => new Map(), subscribe: () => () => {} },
      forSession: () => ({ getSnapshot: () => [], subscribe: () => () => {} }),
    },
  } as never)

  let listener: QuestionListener | undefined
  const on = vi.fn((event: string, value: QuestionListener) => {
    expect(event).toBe('user-questions/request')
    listener = value
    return () => { listener = undefined }
  })
  ctx.provide('remote', { $on: on } as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()

  return {
    ctx,
    slots,
    owner,
    scopeOf,
    present,
    remove,
    on,
    fiber,
    presented: () => presented,
    invoke(request: QuestionRequest, next: QuestionNext, target = owner): Promise<typeof ANSWER> {
      if (listener === undefined) throw new Error('question listener was not installed')
      return listener.call(target, request, next)
    },
  }
}

describe('apply', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slots', 'sessions', 'remote', 'conversation', 'locale'])
  })

  it('installs the Remote Event listener and waits for the composer declaration', async () => {
    const b = await bench(false)
    expect(b.on).toHaveBeenCalledOnce()
    expect(b.slots.entries('conversation.composer')).toHaveLength(0)

    b.slots.register(
      { name: 'root', children: { 'conversation.composer': { kind: 'chain', scope: 'session' } } } as never,
      () => null,
    )
    await Promise.resolve()
    expect(b.slots.entries('conversation.composer')).toHaveLength(1)
  })

  it('delegates a request whose Client Context has no Session', async () => {
    const b = await bench()
    const next = vi.fn(async () => ANSWER)

    await expect(b.invoke({ questions: QUESTIONS }, next, b.ctx)).resolves.toBe(ANSWER)

    expect(next).toHaveBeenCalledOnce()
    expect(b.present).not.toHaveBeenCalled()
  })

  it('publishes one scoped wait and returns its structured answer', async () => {
    const b = await bench()
    const next = vi.fn(async () => ANSWER)
    const result = b.invoke({ questions: QUESTIONS }, next)
    const wait = b.presented()
    if (wait === undefined) throw new Error('question wait was not presented')
    const entry = b.slots.entries('conversation.composer')[0]!
    const select = entry.select as (
      owner: { pendingInteraction: PendingWait<'question'> | undefined },
    ) => PendingWait<'question'> | null

    expect(entry.component).toBe(QuestionComposer)
    expect(entry.inject).toBeUndefined()
    expect(entry.locale).toBe('question')
    expect(select({ pendingInteraction: undefined })).toBeNull()
    expect(select({ pendingInteraction: wait })).toBe(wait)
    expect(b.present).toHaveBeenCalledWith(wait, 'question', 1)

    await new PendingQuestion(wait).answer(ANSWER)
    await expect(result).resolves.toBe(ANSWER)
    expect(next).not.toHaveBeenCalled()
    expect(b.remove).toHaveBeenCalledOnce()
    expect(b.presented()).toBeUndefined()
  })

  it('uses plan-review precedence and preserves ASK_CANCELLED', async () => {
    const b = await bench()
    const questions = [{
      id: 'plan',
      question: 'Approve?',
      detail: '# Plan',
      options: [{ label: 'Approve' }, { label: 'Keep planning' }],
      intent: { kind: 'plan-review' as const, approve: 'Approve' },
    }]
    const result = b.invoke({ questions }, async () => ANSWER)
    const wait = b.presented()
    if (wait === undefined) throw new Error('plan review wait was not presented')

    expect(b.present).toHaveBeenCalledWith(wait, 'plan-review', 2)
    const rejection = expect(result).rejects.toMatchObject({
      name: 'UserQuestionError',
      code: 'ASK_CANCELLED',
    })
    await new PendingQuestion(wait).cancel()
    await rejection
    expect(b.remove).toHaveBeenCalledOnce()
  })

  it('preserves a non-cancellation question rejection', async () => {
    const b = await bench()
    const result = b.invoke({ questions: QUESTIONS }, async () => ANSWER)
    const wait = b.presented()
    if (wait === undefined) throw new Error('question wait was not presented')

    const rejection = expect(result).rejects.toMatchObject({
      name: 'UserQuestionError',
      code: 'provider-failed',
      message: 'provider failed',
    })
    await wait.respond({
      ok: false,
      error: { code: 'provider-failed', message: 'provider failed', details: {} },
    })
    await rejection
    expect(b.remove).toHaveBeenCalledOnce()
  })

  it('removes an aborted request and its signal listener', async () => {
    const b = await bench()
    const controller = new AbortController()
    const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener')
    const reason = new DOMException('aborted by Host', 'AbortError')
    const result = b.invoke({ questions: QUESTIONS, signal: controller.signal }, async () => ANSWER)
    expect(b.presented()).toBeDefined()

    controller.abort(reason)

    await expect(result).rejects.toBe(reason)
    expect(removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(b.remove).toHaveBeenCalledOnce()
    expect(b.presented()).toBeUndefined()
  })

  it('removes a request whose signal was already aborted', async () => {
    const b = await bench()
    const controller = new AbortController()
    controller.abort()

    const result = b.invoke({ questions: QUESTIONS, signal: controller.signal }, async () => ANSWER)

    await expect(result).rejects.toBe(controller.signal.reason)
    expect(b.remove).toHaveBeenCalledOnce()
    expect(b.presented()).toBeUndefined()
  })

  it('teardown unregisters the stable composer entry', async () => {
    const b = await bench()
    expect(b.slots.entries('conversation.composer')).toHaveLength(1)
    await b.fiber.dispose()
    expect(b.slots.entries('conversation.composer')).toHaveLength(0)
  })
})
