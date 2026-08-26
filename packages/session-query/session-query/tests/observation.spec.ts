import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import type { BorrowedSessionSource } from '@deepseek-ai/dsh-session-persistence'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it, vi } from 'vitest'
import { SessionObservationReader } from '../src/observation.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    'observation-test/seed': number
  }
  interface SessionProjectionMap {
    'observation-test/seed': number
  }
}

type SeedDefinition = ProjectionDefinition<'observation-test/seed', number>
const seedSchema = {
  parse: (value: unknown) => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new Error('invalid observation test seed')
    }
    return value
  },
} as SeedDefinition['stateSchema']

const seedUnit = {
  key: 'observation-test/seed',
  stateSchema: seedSchema,
  init: (seedLength: number) => seedLength,
  apply: (state: number) => state,
  wire: { viewSchema: seedSchema, view: (state: number) => state },
  stateVersion: 1,
} satisfies SeedDefinition

function header(id: string, seedLength?: number): SessionHeader {
  return {
    version: 0,
    id: SessionId(id),
    createdAt: 1,
    cwd: '/workspace',
    ...seedLength === undefined ? {} : { seedLength },
  }
}

function preparedSource(
  meta: SessionHeader,
  dispose = vi.fn(),
  events: readonly SessionEvent[] = [],
): BorrowedSessionSource {
  const preparedSession = Session.create(meta.id, events, meta)
  return {
    source: 'prepared',
    inspection: { meta: preparedSession.header, events: preparedSession.events },
    revision: SessionPersistenceRevision(`fixture:${meta.id}`),
    preparedSession,
    [Symbol.dispose]: dispose,
  }
}

describe('SessionObservationReader', () => {
  it('uses the normalized fork seed for live and prepared projection observations', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    ctx.sessionProjections.register(seedUnit)
    const events = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as SessionEvent[]
    const live = ctx.sessions.create(SessionId('live-seed'), {
      seed: events,
      meta: { cwd: '/workspace', seedLength: 2 },
    })
    using liveObservation = await new SessionObservationReader(ctx).read(live.id)
    expect(liveObservation.projections?.values['observation-test/seed']).toBe(2)

    const coldHeader = header('prepared-seed', 2)
    ctx.provide('sessionPersistence', {
      borrowSession: () => Promise.resolve(preparedSource(coldHeader, vi.fn(), events)),
    } as never)
    using preparedObservation = await new SessionObservationReader(ctx).read(coldHeader.id)
    expect(preparedObservation.projections?.values['observation-test/seed']).toBe(2)
    await ctx.fiber.dispose()
  })

  it('prefers a live Session that attaches while a prepared source is borrowed', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const meta = header('attached-during-borrow')
    const dispose = vi.fn()
    const prepared = preparedSource(meta, dispose)
    ctx.provide('sessionPersistence', {
      borrowSession: () => {
        ctx.sessions.create(meta.id, { meta })
        return Promise.resolve(prepared)
      },
    } as never)

    using observed = await new SessionObservationReader(ctx).read(meta.id, { projectionMode: 'none' })

    expect(observed.source).toBe('live')
    expect(dispose).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('releases a borrowed source once when the winning live projection fails', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const meta = header('attached-projection-failure')
    const dispose = vi.fn()
    const prepared = preparedSource(meta, dispose)
    ctx.provide('sessionPersistence', {
      borrowSession: () => {
        ctx.sessions.create(meta.id, { meta })
        return Promise.resolve(prepared)
      },
    } as never)
    vi.spyOn(ctx.sessionProjections, 'snapshot').mockImplementation(() => {
      throw new Error('projection failed')
    })

    await expect(new SessionObservationReader(ctx).read(meta.id)).rejects.toThrow('projection failed')
    expect(dispose).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('retries when persistence reports a live source that has already detached', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const meta = header('detached-live-source')
    const disposeLive = vi.fn()
    const prepared = preparedSource(meta)
    const borrowSession = vi.fn()
      .mockResolvedValueOnce({
        source: 'live', inspection: { meta, events: [] }, [Symbol.dispose]: disposeLive,
      } satisfies BorrowedSessionSource)
      .mockResolvedValueOnce(prepared)
    ctx.provide('sessionPersistence', { borrowSession } as never)

    using observed = await new SessionObservationReader(ctx).read(meta.id, { projectionMode: 'none' })

    expect(observed.source).toBe('prepared')
    expect(borrowSession).toHaveBeenCalledTimes(2)
    expect(disposeLive).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('reference-counts prepared leases and rejects retention after disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const meta = header('prepared-leases')
    const dispose = vi.fn()
    ctx.provide('sessionPersistence', {
      borrowSession: () => Promise.resolve(preparedSource(meta, dispose)),
    } as never)
    const observed = await new SessionObservationReader(ctx).read(meta.id, { projectionMode: 'none' })
    const retained = observed.retain()

    observed[Symbol.dispose]()
    observed[Symbol.dispose]()
    expect(dispose).not.toHaveBeenCalled()
    expect(() => observed.retain()).toThrow('is disposed')
    retained[Symbol.dispose]()
    expect(dispose).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('creates independent live leases and rejects retention after disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('live-leases'), { meta: { cwd: '/workspace' } })
    const reader = new SessionObservationReader(ctx)
    const observed = await reader.read(session.id, { projectionMode: 'none' })
    const retained = observed.retain()

    observed[Symbol.dispose]()
    expect(() => observed.retain()).toThrow('is disposed')
    expect(retained.source).toBe('live')
    retained[Symbol.dispose]()
    await ctx.fiber.dispose()
  })

  it('contains a non-Error persistence rejection', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const rejection = 'offline' as unknown as Error
    ctx.provide('sessionPersistence', {
      // Exercise containment of a backend that violates the Error rejection convention.
      borrowSession: () => Promise.reject(rejection),
    } as never)

    await expect(new SessionObservationReader(ctx).read(SessionId('failed'))).rejects.toMatchObject({
      code: 'SESSION_QUERY_PERSISTENCE_FAILED',
      message: expect.stringContaining('unknown error') as string,
    })
    await ctx.fiber.dispose()
  })
})
