import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { PendingWait } from '@deepseek-ai/dsh-client-runtime/client'
import { PendingInteractionPresenter } from '../src/client/pending-interactions.ts'

const sid = (value: string) => value as SessionId

function approval(id: string, sessionId = sid('session')): PendingWait<'approval'> {
  return new PendingWait(
    'approval', id, sessionId, { approvalId: id, toolName: 'bash' },
    () => Promise.resolve({ ok: true, value: { accepted: true } }),
  )
}

function question(id: string, sessionId = sid('session')): PendingWait<'question'> {
  return new PendingWait(
    'question', id, sessionId, { questions: [{ id: 'choice', question: 'Choose?' }] },
    () => Promise.resolve({ ok: true, value: { accepted: true } }),
  )
}

describe('PendingInteractionPresenter', () => {
  it('publishes one effective interaction and status per Session by precedence', () => {
    const presenter = new PendingInteractionPresenter()
    const source = presenter.forSession(sid('session'))
    const notifyInteraction = vi.fn()
    const notifyStatuses = vi.fn()
    source.subscribe(notifyInteraction)
    presenter.statuses.subscribe(notifyStatuses)
    const approvalWait = approval('approval')
    const questionWait = question('question')

    const removeApproval = presenter.present(approvalWait, 'approval', 0)
    expect(source.getSnapshot()).toEqual([approvalWait])
    expect(presenter.statuses.getSnapshot().get(sid('session'))).toBe('approval')

    const removeQuestion = presenter.present(questionWait, 'question', 1)
    expect(source.getSnapshot()).toEqual([questionWait])
    expect(presenter.statuses.getSnapshot().get(sid('session'))).toBe('question')

    removeQuestion()
    expect(source.getSnapshot()).toEqual([approvalWait])
    removeApproval()
    expect(source.getSnapshot()).toEqual([])
    expect(presenter.statuses.getSnapshot()).toEqual(new Map())
    expect(notifyInteraction).toHaveBeenCalledTimes(4)
    expect(notifyStatuses).toHaveBeenCalledTimes(4)
  })

  it('uses publication order to replace an equal-precedence interaction', () => {
    const presenter = new PendingInteractionPresenter()
    const source = presenter.forSession(sid('session'))
    const first = question('first')
    const second = question('second')
    const removeFirst = presenter.present(first, 'question', 1)
    const removeSecond = presenter.present(second, 'plan-review', 1)

    expect(source.getSnapshot()).toEqual([second])
    expect(presenter.statuses.getSnapshot().get(sid('session'))).toBe('plan-review')
    removeSecond()
    expect(source.getSnapshot()).toEqual([first])
    removeFirst()
  })

  it('isolates Sessions, rejects duplicate keys, and removes idempotently', () => {
    const presenter = new PendingInteractionPresenter()
    const first = approval('same', sid('first'))
    const secondSession = approval('second', sid('second'))
    const removeFirst = presenter.present(first, 'approval', 0)
    const removeSecond = presenter.present(secondSession, 'approval', 0)

    expect(presenter.forSession(sid('first')).getSnapshot()).toEqual([first])
    expect(presenter.forSession(sid('second')).getSnapshot()).toEqual([secondSession])
    expect(() => presenter.present(approval('same', sid('first')), 'approval', 0))
      .toThrow("duplicate pending interaction key 'a:same'")

    removeFirst()
    removeFirst()
    expect(() => first.respond({
      ok: true,
      value: { sessionId: sid('first'), approvalId: 'same', outcome: 'rejected' },
    })).toThrow('already settled')
    expect(presenter.forSession(sid('first')).getSnapshot()).toEqual([])
    expect(presenter.forSession(sid('second')).getSnapshot()).toEqual([secondSession])
    removeSecond()
  })

  it('returns stable empty sources for absent and known Sessions', () => {
    const presenter = new PendingInteractionPresenter()
    const absent = presenter.forSession(undefined)
    const first = presenter.forSession(sid('first'))

    expect(presenter.forSession(undefined)).toBe(absent)
    expect(absent.getSnapshot()).toEqual([])
    const dispose = absent.subscribe(() => {})
    dispose()
    expect(presenter.forSession(sid('first'))).toBe(first)
    expect(first.getSnapshot()).toEqual([])
  })
})
