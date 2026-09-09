/** Inbox projection delivery and queue-operation transport. */

import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { InboxState } from '@deepseek-ai/dsh-agent/types'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { SessionControlFrame } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SessionManager } from '../src/client/sessions/manager.ts'
import { deferred, FakeApiClient, fakeRemote, ok } from './fake-api.client.ts'

const SID = 'fk-q1' as SessionId
const text = (value: string): ContentBlock[] => [{ type: 'text', text: value }]

let nextSeq = 1

function message(label: string, body: string) {
  return createUserMessage({
    content: text(body),
    source: { kind: 'user', rpcId: `rpc-${label}` } as never,
  })
}

function inboxFrame(value: InboxState): Extract<SessionControlFrame, { type: 'projection' }> {
  return {
    type: 'projection',
    sessionId: SID,
    key: 'inbox',
    seq: nextSeq++,
    value: value as never,
  }
}

describe('Inbox projection intake', () => {
  it('stores the complete Agent-owned value without adding queue state to the Session snapshot', () => {
    const manager = new SessionManager(fakeRemote(new FakeApiClient()))
    const queued = message('queued', 'later')
    const steering = message('steering', 'now')
    const value = { 'next-turn': [queued], 'next-step': [steering] }

    manager.handleControlFrame(inboxFrame(value))
    const session = manager.get(SID)

    expect(session.projections.faceOf('inbox').getSnapshot()).toEqual(value)
    expect(session.getSnapshot()).not.toHaveProperty('queue')
  })

  it.each(['included', 'omitted'] as const)(
    'keeps a newer list Inbox when a delayed control baseline has the key %s',
    async (key) => {
      const api = new FakeApiClient()
      const list = deferred<Awaited<ReturnType<FakeApiClient['onList']>>>()
      api.onList = () => list.promise
      const manager = new SessionManager(fakeRemote(api))
      const empty = { 'next-turn': [], 'next-step': [] }
      const stale = { ...empty, 'next-turn': [message('removed', 'already removed')] }
      const result = ok({ items: [{
        sessionId: SID, updatedAt: 1, running: false, blank: false,
        projections: { asOfSeq: 21, values: { inbox: empty } },
      }] }) as Awaited<ReturnType<FakeApiClient['onList']>>
      let refreshed: Promise<void> | undefined

      try {
        manager.handleConnected()
        refreshed = manager.refreshList()
        list.resolve(result)
        await refreshed
        const face = manager.get(SID).projections.faceOf('inbox')
        expect(face.getSnapshot()).toEqual(empty)

        manager.handleControlFrame({
          type: 'baseline',
          value: { jobs: {}, projections: { [SID]: {
            asOfSeq: 20, values: key === 'included' ? { inbox: stale } : {},
          } } },
        } as SessionControlFrame)

        expect(face.getSnapshot()).toEqual(empty)
      } finally {
        list.resolve(result)
        await refreshed
        await manager.dispose()
      }
    },
  )

  it.each(['control-first', 'list-first'] as const)(
    'replaces cold Session Inbox values across Host generations (%s)',
    async (order) => {
      const api = new FakeApiClient()
      const list = deferred<Awaited<ReturnType<FakeApiClient['onList']>>>()
      api.onList = () => list.promise
      const manager = new SessionManager(fakeRemote(api))
      const hiddenSessionId = 'cold-hidden-inbox' as SessionId
      const ghost = message('ghost', 'acceptance was not persisted')
      const pending = message('pending', 'claim was not persisted')
      const empty = { 'next-turn': [], 'next-step': [] }
      const restored = { 'next-turn': [pending], 'next-step': [] }
      manager.handleControlFrame({ ...inboxFrame({ ...empty, 'next-turn': [ghost] }), seq: 20 })
      manager.handleControlFrame({ ...inboxFrame(empty), sessionId: hiddenSessionId, seq: 20 })
      const face = manager.get(SID).projections.faceOf('inbox')
      const baseline = { type: 'baseline', value: { jobs: {}, projections: {} } } as const
      const result = ok({ items: [
        { sessionId: SID, updatedAt: 1, running: false, blank: false,
          projections: { asOfSeq: 1, values: { inbox: empty } } },
        { sessionId: hiddenSessionId, updatedAt: 1, running: false, blank: false,
          projections: { asOfSeq: 1, values: { inbox: restored } } },
      ] }) as Awaited<ReturnType<FakeApiClient['onList']>>
      let refreshed: Promise<void> | undefined

      try {
        manager.handleConnected()
        refreshed = manager.refreshList()
        expect(face.getSnapshot()).toBeUndefined()
        if (order === 'control-first') manager.handleControlFrame(baseline)
        list.resolve(result)
        await refreshed
        if (order === 'list-first') manager.handleControlFrame(baseline)

        expect(manager.get(SID).projections.faceOf('inbox')).toBe(face)
        expect(face.getSnapshot()).toEqual(empty)
        expect(manager.get(hiddenSessionId).projections.faceOf('inbox').getSnapshot()).toEqual(restored)
      } finally {
        list.resolve(result)
        await refreshed
        await manager.dispose()
      }
    },
  )

  it('retains only the highest-seq value received before Session materialization', () => {
    const manager = new SessionManager(fakeRemote(new FakeApiClient()))
    manager.handleControlFrame(inboxFrame({
      'next-turn': [message('old', 'old')],
      'next-step': [],
    }))
    const latest = {
      'next-turn': [message('latest', 'latest')],
      'next-step': [],
    }
    manager.handleControlFrame(inboxFrame(latest))

    expect(manager.get(SID).projections.faceOf('inbox').getSnapshot()).toEqual(latest)
  })
})

describe('queue operation transport', () => {
  it('does not mutate the Inbox projection before the Host publishes its committed value', async () => {
    const api = new FakeApiClient()
    const manager = new SessionManager(fakeRemote(api))
    const pending = message('pending', 'before')
    const initial = { 'next-turn': [pending], 'next-step': [] }
    manager.handleControlFrame(inboxFrame(initial))
    const session = manager.get(SID)

    await expect(session.updateQueue(pending.id, { kind: 'edit', content: text('after') }))
      .resolves.toEqual({ ok: true, value: { accepted: true } })
    expect(api.callsOf('session.updateQueue')).toEqual([{
      sessionId: SID,
      itemId: pending.id,
      action: { kind: 'edit', content: text('after') },
    }])
    expect(session.projections.faceOf('inbox').getSnapshot()).toBe(initial)
  })
})
