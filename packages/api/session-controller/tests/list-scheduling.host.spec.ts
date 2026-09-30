/** Event-loop fairness and cancellation of synchronous Session-list summaries. */

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { SessionRecord } from '@deepseek-ai/dsh-session-query'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiSessionList } from '../src/list.ts'

type Phase = 'live' | 'cold'
interface Row {
  id: string
  phase: Phase
  cwd?: false
}

const contexts = new Set<Context>()
const immediates = new Set<ReturnType<typeof setImmediate>>()

afterEach(async () => {
  for (const handle of immediates) clearImmediate(handle)
  immediates.clear()
  vi.restoreAllMocks()
  try {
    await Promise.all([...contexts].map(ctx => ctx.fiber.dispose()))
  } finally {
    contexts.clear()
  }
})

function betweenRows(action: () => void): void {
  const handle = setImmediate(() => {
    immediates.delete(handle)
    action()
  })
  immediates.add(handle)
}

async function harness(rows: readonly Row[]) {
  const ctx = new Context()
  contexts.add(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  const list = new ApiSessionList(ctx)
  const prepared = new Map<string, Session>()
  const agents = new Map<string, { status: Agent['status'] }>()
  const detach = new Map<string, () => void>()
  const trace: string[] = []
  const observer: { summary: (phase: Phase, id: string) => void } = { summary: () => {} }
  const recordSummary = (phase: Phase, id: string): void => {
    trace.push(`${phase}:${id}`)
    observer.summary(phase, id)
  }
  const attach = (id: string): void => {
    const session = prepared.get(id)
    if (session === undefined) throw new Error(`missing prepared Session ${id}`)
    const detachSession = ctx.sessions.enter(session)
    ctx.effect(() => detachSession, 'list-scheduling.session')
    ctx.sessions.announce(session)
    const agent = { id: session.id, session, ctx, status: 'idle' as Agent['status'] }
    // Only registry lookup and status are consumed; no Agent execution occurs in this fixture.
    const detachAgent = ctx.agents.enter(agent as Agent, undefined)
    ctx.effect(() => detachAgent, 'list-scheduling.agent')
    agents.set(id, agent)
    detach.set(id, () => { detachAgent(); detachSession() })
  }
  const records: SessionRecord[] = rows.map((row) => {
    const session = ctx.sessions.prepare(SessionId(row.id), {
      meta: { createdAt: 100, ...(row.cwd === false ? {} : { cwd: resolve('list-scheduling-fixture') }) },
    })
    prepared.set(row.id, session)
    if (row.phase === 'live') attach(row.id)
    return { header: session.header, live: row.phase === 'live', persisted: true }
  })
  const listSessions = vi.fn(async (_signal?: AbortSignal) => records)
  ctx.provide('sessionQuery', { listSessions } as never)
  ctx.provide('sessionProjectionCache', {
    cachedSnapshot: (header: SessionRecord['header']) => {
      recordSummary('cold', header.id)
      return { asOfSeq: -1, values: { sessionListMetadata: { blank: false, lastPromptAt: null } } }
    },
    cachedPredecessorTitle: () => undefined,
  } as never)
  const summaryFor = list.summaryFor.bind(list)
  vi.spyOn(list, 'summaryFor').mockImplementation((session) => {
    const summary = summaryFor(session)
    recordSummary('live', session.id)
    return summary
  })
  return { ctx, list, listSessions, trace, observer, attach, agents, detach }
}

describe('Session-list row scheduling', () => {
  it.each<Phase>(['live', 'cold'])('runs immediates between %s summaries and before resolving the final row', async (phase) => {
    const h = await harness([{ id: 'first', phase }, { id: 'middle', phase }, { id: 'last', phase }])
    h.observer.summary = (_phase, id) => { betweenRows(() => { h.trace.push(`immediate:${id}`) }) }

    const items = await h.list.list()
    h.trace.push('resolved')

    expect(h.trace).toEqual([
      `${phase}:first`, 'immediate:first', `${phase}:middle`, 'immediate:middle',
      `${phase}:last`, 'immediate:last', 'resolved',
    ])
    expect(items.map(item => item.sessionId)).toEqual(['first', 'middle', 'last'])
  })

  it.each([
    { phase: 'live', abortAt: 'first' },
    { phase: 'live', abortAt: 'last' },
    { phase: 'cold', abortAt: 'first' },
    { phase: 'cold', abortAt: 'last' },
  ] as const)('preserves cancellation after the $abortAt $phase row', async ({ phase, abortAt }) => {
    const h = await harness([{ id: 'first', phase }, { id: 'middle', phase }, { id: 'last', phase }])
    const lookup = vi.spyOn(h.ctx.sessions, 'get')
    const controller = new AbortController()
    const reason = { cancellation: `${phase}-${abortAt}` }
    h.observer.summary = (_phase, id) => {
      if (id === abortAt) betweenRows(() => { controller.abort(reason) })
    }

    await expect(h.list.list(controller.signal)).rejects.toBe(reason)
    expect(h.trace).toEqual(abortAt === 'first'
      ? [`${phase}:first`]
      : [`${phase}:first`, `${phase}:middle`, `${phase}:last`])
    expect(h.listSessions).toHaveBeenCalledExactlyOnceWith(controller.signal)
    if (phase === 'live' && abortAt === 'first') {
      expect(lookup).toHaveBeenCalledExactlyOnceWith(SessionId('first'))
    }
  })

  it('does not start cold summaries after cancellation during the last live row', async () => {
    const h = await harness([{ id: 'cold', phase: 'cold' }, { id: 'live', phase: 'live' }])
    const controller = new AbortController()
    const reason = new Error('cancel before cold phase')
    h.observer.summary = (phase) => {
      if (phase === 'live') betweenRows(() => { controller.abort(reason) })
    }

    await expect(h.list.list(controller.signal)).rejects.toBe(reason)
    expect(h.trace).toEqual(['live:live'])
  })

  it('rejects a pre-aborted request before querying headers', async () => {
    const h = await harness([{ id: 'live', phase: 'live' }])
    const controller = new AbortController()
    const reason = new Error('already cancelled')
    controller.abort(reason)

    await expect(h.list.list(controller.signal)).rejects.toBe(reason)
    expect(h.listSessions).not.toHaveBeenCalled()
    expect(h.trace).toEqual([])
  })

  it('checks cancellation after the header query before summarizing any row', async () => {
    const h = await harness([{ id: 'cold', phase: 'cold' }])
    const controller = new AbortController()
    const reason = new Error('query cancelled')
    h.listSessions.mockImplementation(async () => {
      controller.abort(reason)
      return []
    })

    await expect(h.list.list(controller.signal)).rejects.toBe(reason)
    expect(h.trace).toEqual([])
  })

  it('returns an empty list without invoking a summary', async () => {
    const h = await harness([])
    await expect(h.list.list()).resolves.toEqual([])
    expect(h.trace).toEqual([])
  })

  it('omits cwd-less cold rows but retains cwd-less attached Sessions', async () => {
    const h = await harness([
      { id: 'omitted-first', phase: 'cold', cwd: false },
      { id: 'visible-cold', phase: 'cold' },
      { id: 'visible-live', phase: 'live', cwd: false },
      { id: 'omitted-last', phase: 'cold', cwd: false },
    ])

    const items = await h.list.list()

    expect(h.trace).toEqual(['live:visible-live', 'cold:visible-cold'])
    expect(items.map(item => item.sessionId)).toEqual(['visible-live', 'visible-cold'])
    expect(items[0]).not.toHaveProperty('cwd')
  })

  it('keeps live-before-cold stable ties despite interleaved query order', async () => {
    const h = await harness([
      { id: 'cold-a', phase: 'cold' }, { id: 'live-a', phase: 'live' },
      { id: 'cold-b', phase: 'cold' }, { id: 'live-b', phase: 'live' },
    ])

    const items = await h.list.list()

    expect(h.trace).toEqual(['live:live-a', 'live:live-b', 'cold:cold-a', 'cold:cold-b'])
    expect(items.map(item => item.sessionId)).toEqual(['live-a', 'live-b', 'cold-a', 'cold-b'])
    expect(items.map(item => item.updatedAt)).toEqual([100, 100, 100, 100])
  })

  it('observes later attachment and status changes without reclassifying queued cold rows', async () => {
    const h = await harness([
      { id: 'queued', phase: 'cold' }, { id: 'first', phase: 'live' },
      { id: 'removed', phase: 'live' }, { id: 'promoted', phase: 'cold' },
      { id: 'status', phase: 'live' },
    ])
    h.observer.summary = (_phase, id) => {
      if (id !== 'first') return
      betweenRows(() => {
        h.detach.get('removed')!()
        h.attach('queued')
        h.attach('promoted')
        h.agents.get('first')!.status = 'running'
        h.agents.get('promoted')!.status = 'running'
        h.agents.get('status')!.status = 'running'
      })
    }

    const items = await h.list.list()

    expect(h.trace).toEqual(['live:first', 'live:promoted', 'live:status', 'cold:queued', 'cold:removed'])
    expect(items.map(({ sessionId, agentAvailable, running }) => ({ sessionId, agentAvailable, running }))).toEqual([
      { sessionId: 'first', agentAvailable: true, running: false },
      { sessionId: 'promoted', agentAvailable: true, running: true },
      { sessionId: 'status', agentAvailable: true, running: true },
      { sessionId: 'queued', agentAvailable: false, running: false },
      { sessionId: 'removed', agentAvailable: false, running: false },
    ])
    expect(h.ctx.agents.get(SessionId('queued'))).toBeDefined()
    expect(h.ctx.sessions.get(SessionId('removed'))).toBeUndefined()
  })
})
