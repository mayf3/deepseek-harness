/**
 * Projection value store (push model; session-projection subsystem page:
 * docs/subsystems/session-projection.md): tentative list prewarm versus
 * authoritative baselines and frames, capability absence as undefined,
 * generation truncation, and the Session/manager wiring (tail-page seeding,
 * control-stream projection routing pre- and post-instantiation, the list
 * rows' title projection).
 */
import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { ProjectionValueStore } from '../src/client/sessions/projection-store.ts'
import { Session } from '../src/client/sessions/session.ts'
import { SessionManager } from '../src/client/sessions/manager.ts'
import { FakeApiClient, deferred, err, fakeRemote, ok } from './fake-api.client.ts'
import { entries, plainTurn } from './event-script.client.ts'

// Test-domain keys merged into the projection map (the Service Definition package's
// pure-type outlet), the same way domain host plugins merge theirs.
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    'test/marks': { marks: string[] }
  }
}

const SID = 'fk-s1' as SessionId

describe('Session projection value semantics', () => {
  it('reads undefined until a value lands (capability absence)', () => {
    const store = new ProjectionValueStore()
    expect(store.get('test/marks')).toBeUndefined()
    expect(store.faceOf('test/marks').getSnapshot()).toBeUndefined()
  })

  it('applies frames last-wins by seq: replayed and stale frames drop', () => {
    const store = new ProjectionValueStore()
    store.apply('test/marks', { marks: ['a'] }, 5)
    store.apply('test/marks', { marks: ['a', 'b'] }, 9)
    expect(store.get('test/marks')).toEqual({ marks: ['a', 'b'] })
    store.apply('test/marks', { marks: ['stale'] }, 5)
    store.apply('test/marks', { marks: ['equal'] }, 9)
    expect(store.get('test/marks')).toEqual({ marks: ['a', 'b'] })
  })

  it('prewarms only tentative rows and promotes an equal-seq authoritative frame', () => {
    const store = new ProjectionValueStore()
    store.prewarm('test/marks', { marks: ['hint-5'] }, 5)
    store.prewarm('test/marks', { marks: ['stale-hint'] }, 3)
    expect(store.get('test/marks')).toEqual({ marks: ['hint-5'] })
    store.prewarm('test/marks', { marks: ['hint-9'] }, 9)
    store.apply('test/marks', { marks: ['frame-9'] }, 9)
    store.prewarm('test/marks', { marks: ['later-hint'] }, 20)
    expect(store.get('test/marks')).toEqual({ marks: ['frame-9'] })
  })

  it('a complete baseline replaces hints but preserves newer authoritative frames', () => {
    const store = new ProjectionValueStore()
    store.prewarm('test/marks', { marks: ['hint-20'] }, 20)
    store.prewarm('hint-only', 'stale', 20)
    store.apply('frame-only', 'frame-20', 20)
    store.seed({ asOfSeq: 10, values: { 'test/marks': { marks: ['baseline-10'] } } })
    expect(store.get('test/marks')).toEqual({ marks: ['baseline-10'] })
    expect(store.get('hint-only')).toBeUndefined()
    expect(store.get('frame-only')).toBe('frame-20')
    store.apply('test/marks', { marks: ['frame-20'] }, 20)
    store.seed({ asOfSeq: 15, values: { 'test/marks': { marks: ['baseline-15'] } } })
    expect(store.get('test/marks')).toEqual({ marks: ['frame-20'] })
    store.seed({ asOfSeq: 30, values: { 'test/marks': { marks: ['baseline-30'] } } })
    expect(store.get('test/marks')).toEqual({ marks: ['baseline-30'] })
    store.seed({ asOfSeq: 40, values: {} })
    expect(store.get('test/marks')).toBeUndefined()
  })

  it('truncate drops rows past the durable baseline and keeps the rest', () => {
    const store = new ProjectionValueStore()
    store.apply('test/marks', { marks: ['durable'] }, 5)
    store.apply('other', 'phantom', 50)
    store.truncate(10)
    expect(store.get('test/marks')).toEqual({ marks: ['durable'] })
    expect(store.get('other')).toBeUndefined()
  })

  it('notifies the key face on change (batched) and not on dropped applications', async () => {
    const store = new ProjectionValueStore()
    let keyTicks = 0
    let anyTicks = 0
    store.faceOf('test/marks').subscribe(() => { keyTicks += 1 })
    store.subscribeAny(() => { anyTicks += 1 })
    store.apply('test/marks', { marks: ['a'] }, 5)
    await Promise.resolve()
    expect(keyTicks).toBe(1)
    expect(anyTicks).toBe(1)
    store.apply('test/marks', { marks: ['replay'] }, 3)
    await Promise.resolve()
    expect(keyTicks).toBe(1)
    expect(anyTicks).toBe(1)
  })

  it('faces are identity-stable per key (the React binding cache premise)', () => {
    const store = new ProjectionValueStore()
    expect(store.faceOf('test/marks')).toBe(store.faceOf('test/marks'))
  })

  it('publishes one reference-stable whole-value snapshot until a row changes', () => {
    const store = new ProjectionValueStore()
    const empty = store.values()
    expect(store.values()).toBe(empty)
    store.apply('test/marks', { marks: ['a'] }, 1)
    const populated = store.values()
    expect(populated).toEqual({ 'test/marks': { marks: ['a'] } })
    expect(populated).not.toBe(empty)
    expect(store.values()).toBe(populated)
  })
})

describe('Session tail-page seeding', () => {
  it('retains a prewarmed projection when opening the Session fails', async () => {
    const api = new FakeApiClient()
    const projections = new ProjectionValueStore()
    projections.prewarm('test/marks', { marks: ['cached'] }, 5)
    const session = new Session(SID, api, fakeRemote(api), { projections })
    api.onHistory = () => Promise.resolve(err({
      code: 'session-not-found',
      message: 'gone',
      details: { sessionId: SID },
    }))

    await session.open()

    expect(session.getSnapshot().openState).toBe('error')
    expect(session.projections.get('test/marks')).toEqual({ marks: ['cached'] })
  })

  it('seeds the store from a history response carrying a projections block', async () => {
    const api = new FakeApiClient()
    const session = new Session(SID, api, fakeRemote(api))
    api.onHistory = () => Promise.resolve(ok({
      records: entries(plainTurn(0, 0, '问', '答')) as never[], hasMore: false,
      projections: { asOfSeq: 5, values: { 'test/marks': { marks: ['from-baseline'] } } },
    } as never))
    await session.open()
    expect(session.projections.get('test/marks')).toEqual({ marks: ['from-baseline'] })
  })

  it('replaces a higher-seq prewarm hint after a successful opening', async () => {
    const api = new FakeApiClient()
    const projections = new ProjectionValueStore()
    projections.prewarm('test/marks', { marks: ['stale-list'] }, 9)
    const session = new Session(SID, api, fakeRemote(api), { projections })
    api.onHistory = () => Promise.resolve(ok({
      records: entries(plainTurn(0, 0, 'a', 'b')) as never[], hasMore: false,
      projections: { asOfSeq: 2, values: { 'test/marks': { marks: ['authoritative'] } } },
    } as never))

    await session.open()

    expect(session.getSnapshot().openState).toBe('open')
    expect(session.projections.get('test/marks')).toEqual({ marks: ['authoritative'] })
  })

  it('preserves an authoritative frame that lands while opening waits for its older baseline', async () => {
    const api = new FakeApiClient()
    const history = deferred<Awaited<ReturnType<FakeApiClient['onHistory']>>>()
    api.onHistory = () => history.promise
    const session = new Session(SID, api, fakeRemote(api))

    const opening = session.open()
    session.projections.apply('test/marks', { marks: ['live-3'] }, 3)
    history.resolve(ok({
      records: entries(plainTurn(0, 0, 'a', 'b')) as never[], hasMore: false,
      projections: { asOfSeq: 2, values: { 'test/marks': { marks: ['baseline-2'] } } },
    } as never))
    await opening

    expect(session.projections.get('test/marks')).toEqual({ marks: ['live-3'] })
  })

  it('a resync serving a stale block keeps the newer pushed value (seq rule end to end)', async () => {
    const api = new FakeApiClient()
    const session = new Session(SID, api, fakeRemote(api))
    api.onHistory = () => Promise.resolve(ok({
      records: entries(plainTurn(0, 0, 'a', 'b')) as never[], hasMore: false,
      projections: { asOfSeq: 5, values: { 'test/marks': { marks: ['baseline'] } } },
    } as never))
    await session.open()
    session.projections.apply('test/marks', { marks: ['pushed-9'] }, 9)
    await session.resync()
    expect(session.projections.get('test/marks')).toEqual({ marks: ['pushed-9'] })
  })

  it('treats a blockless response as no reset: pushed values survive', async () => {
    const api = new FakeApiClient()
    const session = new Session(SID, api, fakeRemote(api))
    api.onHistory = () => Promise.resolve(ok({ records: entries(plainTurn(0, 0, 'a', 'b')) as never[], hasMore: false }))
    await session.open()
    session.projections.apply('test/marks', { marks: ['pushed'] }, 9)
    await session.resync()
    expect(session.projections.get('test/marks')).toEqual({ marks: ['pushed'] })
  })
})

describe('manager frame routing', () => {
  const sid = (s: string): SessionId => s as SessionId

  it('lands projection frames before instantiation and the Session adopts the same store', async () => {
    const api = new FakeApiClient()
    const manager = new SessionManager(api, fakeRemote(api))
    manager.handleControlFrame({
      type: 'projection', sessionId: sid('s1'), key: 'test/marks', value: { marks: ['early'] }, seq: 7,
    })
    const session = manager.get(sid('s1'))
    expect(session.projections.get('test/marks')).toEqual({ marks: ['early'] })
    // Frames after instantiation land in the same store.
    manager.handleControlFrame({
      type: 'projection', sessionId: sid('s1'), key: 'test/marks', value: { marks: ['later'] }, seq: 9,
    })
    expect(session.projections.get('test/marks')).toEqual({ marks: ['later'] })
  })

  it('projects the title key into list rows and truncates phantom rows on the control baseline', async () => {
    const api = new FakeApiClient()
    const manager = new SessionManager(api, fakeRemote(api))
    api.onList = () => Promise.resolve(ok({
      items: [{ sessionId: sid('s1'), updatedAt: 1, running: false, blank: false }],
    }) as never)
    await manager.refreshList()
    manager.handleControlFrame({
      type: 'projection', sessionId: sid('s1'), key: 'title', value: 'Projected title', seq: 4,
    })
    await Promise.resolve()
    expect(manager.getListSnapshot().items[0]?.title).toBe('Projected title')
    // The durable baseline says the host only knows up to seq 2: the row rode
    // lost state and must drop (the un-flushed title precedent).
    manager.handleControlFrame({
      type: 'baseline',
      value: {
        queues: {}, jobs: {},
        projections: { [sid('s1')]: { asOfSeq: 2, values: {} } },
      },
    })
    await Promise.resolve()
    expect(manager.getListSnapshot().items[0]?.title).toBeUndefined()
  })

  it('projects every retained value into list rows with stable snapshot identity', async () => {
    const api = new FakeApiClient()
    const manager = new SessionManager(api, fakeRemote(api))
    api.onList = () => Promise.resolve(ok({
      items: [{
        sessionId: sid('s1'), updatedAt: 1, running: false, blank: false,
        projections: {
          asOfSeq: 2,
          values: { 'test/marks': { marks: ['baseline'] } },
        },
      }],
    }) as never)
    await manager.refreshList()
    const baseline = manager.getListSnapshot().items[0]?.projectionValues
    expect(baseline).toEqual({ 'test/marks': { marks: ['baseline'] } })
    expect(manager.getListSnapshot().items[0]?.projectionValues).toBe(baseline)

    manager.handleControlFrame({
      type: 'projection', sessionId: sid('s1'), key: 'test/marks',
      value: { marks: ['live'] }, seq: 3,
    })
    await Promise.resolve()
    expect(manager.getListSnapshot().items[0]?.projectionValues)
      .toEqual({ 'test/marks': { marks: ['live'] } })
    expect(manager.getListSnapshot().items[0]?.projectionValues).not.toBe(baseline)
  })

  it('drops the projection store with the removed session', async () => {
    const api = new FakeApiClient()
    const manager = new SessionManager(api, fakeRemote(api))
    api.onList = () => Promise.resolve(ok({
      items: [{ sessionId: sid('s1'), updatedAt: 1, running: false, blank: false }],
    }) as never)
    await manager.refreshList()
    manager.handleControlFrame({
      type: 'projection', sessionId: sid('s1'), key: 'title', value: 'Doomed', seq: 4,
    })
    manager.handleSessionRemoved(sid('s1'))
    expect(manager.get(sid('s1')).projections.get('title')).toBeUndefined()
  })
})
