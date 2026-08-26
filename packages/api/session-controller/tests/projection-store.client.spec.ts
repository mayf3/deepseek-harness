/**
 * Projection value store (push model; session-projection subsystem page:
 * docs/subsystems/session-projection.md): higher-seq-wins for ordinary inputs,
 * exact opening replacement, capability absence as undefined, generation truncation, and the
 * Session/manager wiring (tail-page seeding, control-stream projection routing
 * pre- and post-instantiation, and list-row projection values).
 */
import { describe, expect, it, vi } from 'vitest'
import { RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
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

  it('uses the same higher-seq-wins rule for cached and live values', () => {
    const store = new ProjectionValueStore()
    store.apply('test/marks', { marks: ['cached-5'] }, 5)
    store.apply('test/marks', { marks: ['stale-live'] }, 3)
    store.apply('test/marks', { marks: ['cached-9'] }, 9)
    store.apply('test/marks', { marks: ['equal-live'] }, 9)
    expect(store.get('test/marks')).toEqual({ marks: ['cached-9'] })
  })

  it('a complete baseline updates and clears only rows at or below its cut', () => {
    const store = new ProjectionValueStore()
    store.apply('test/marks', { marks: ['old'] }, 5)
    store.apply('cleared', 'old', 5)
    store.apply('newer', 'newer', 20)
    store.seed({ asOfSeq: 10, values: { 'test/marks': { marks: ['baseline-10'] } } })
    expect(store.get('test/marks')).toEqual({ marks: ['baseline-10'] })
    expect(store.get('cleared')).toBeUndefined()
    expect(store.get('newer')).toBe('newer')
    store.seed({ asOfSeq: 10, values: {} })
    expect(store.get('test/marks')).toBeUndefined()
    expect(store.get('newer')).toBe('newer')
  })

  it('an exact baseline replaces every prior row even when its cut is lower', () => {
    const store = new ProjectionValueStore()
    store.apply('test/marks', { marks: ['ghost'] }, 9)
    store.apply('omitted', 'ghost', 9)
    store.replace({ asOfSeq: 2, values: { 'test/marks': { marks: ['durable'] } } })
    expect(store.get('test/marks')).toEqual({ marks: ['durable'] })
    expect(store.get('omitted')).toBeUndefined()
    store.apply('test/marks', { marks: ['live'] }, 3)
    expect(store.get('test/marks')).toEqual({ marks: ['live'] })
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
    projections.apply('test/marks', { marks: ['cached'] }, 5)
    const session = new Session(SID, fakeRemote(api), { projections })
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
    const session = new Session(SID, fakeRemote(api))
    api.onHistory = () => Promise.resolve(ok({
      records: entries(plainTurn(0, 0, '问', '答')) as never[], hasMore: false,
      projections: { asOfSeq: 5, values: { 'test/marks': { marks: ['from-baseline'] } } },
    } as never))
    await session.open()
    expect(session.projections.get('test/marks')).toEqual({ marks: ['from-baseline'] })
  })

  it('replaces a higher-sequence cache ghost with the exact opening baseline', async () => {
    const api = new FakeApiClient()
    const projections = new ProjectionValueStore()
    projections.apply('test/marks', { marks: ['cached'] }, 9)
    const session = new Session(SID, fakeRemote(api), { projections })
    api.onHistory = () => Promise.resolve(ok({
      records: entries(plainTurn(0, 0, 'a', 'b')) as never[], hasMore: false,
      projections: { asOfSeq: 2, values: { 'test/marks': { marks: ['older-baseline'] } } },
    } as never))

    await session.open()

    expect(session.getSnapshot().openState).toBe('open')
    expect(session.projections.get('test/marks')).toEqual({ marks: ['older-baseline'] })
  })

  it('replays live control frames after replacing cache hints during opening', async () => {
    const api = new FakeApiClient()
    const history = deferred<Awaited<ReturnType<FakeApiClient['onHistory']>>>()
    api.onHistory = () => history.promise
    const projections = new ProjectionValueStore()
    projections.apply('test/marks', { marks: ['cached-9'] }, 9)
    const session = new Session(SID, fakeRemote(api), { projections })

    const opening = session.open()
    session.handleProjectionFrame({
      type: 'projection', sessionId: SID, key: 'test/marks', value: { marks: ['live-3'] }, seq: 3,
    })
    history.resolve(ok({
      records: entries(plainTurn(0, 0, 'a', 'b')) as never[], hasMore: false,
      projections: { asOfSeq: 2, values: { 'test/marks': { marks: ['baseline-2'] } } },
    } as never))
    await opening

    expect(session.projections.get('test/marks')).toEqual({ marks: ['live-3'] })
  })

  it('resync removes pre-operation high rows and replays only control operations that arrive during resync', async () => {
    const api = new FakeApiClient()
    const session = new Session(SID, fakeRemote(api))
    api.onHistory = () => Promise.resolve(ok({
      records: entries(plainTurn(0, 0, 'a', 'b')) as never[], hasMore: false,
      projections: { asOfSeq: 5, values: { 'test/marks': { marks: ['baseline'] } } },
    } as never))
    await session.open()
    session.handleProjectionFrame({
      type: 'projection', sessionId: SID, key: 'test/marks', value: { marks: ['old-9'] }, seq: 9,
    })
    const history = deferred<Awaited<ReturnType<FakeApiClient['onHistory']>>>()
    api.onHistory = () => history.promise
    const resyncing = session.resync()
    session.handleProjectionFrame({
      type: 'projection', sessionId: SID, key: 'test/marks', value: { marks: ['during-3'] }, seq: 3,
    })
    history.resolve(ok({
      records: entries(plainTurn(0, 0, 'a', 'b')) as never[], hasMore: false,
      projections: { asOfSeq: 2, values: { 'test/marks': { marks: ['baseline-2'] } } },
    } as never))
    await resyncing
    expect(session.projections.get('test/marks')).toEqual({ marks: ['during-3'] })
  })

  it('replays a newer control baseline and only its subsequent frames', async () => {
    const api = new FakeApiClient()
    const session = new Session(SID, fakeRemote(api))
    const history = deferred<Awaited<ReturnType<FakeApiClient['onHistory']>>>()
    api.onHistory = () => history.promise
    const opening = session.open()
    session.handleProjectionFrame({
      type: 'projection', sessionId: SID, key: 'test/marks', value: { marks: ['first-frame'] }, seq: 7,
    })
    session.replaceProjectionBaseline({
      asOfSeq: 2, values: { 'test/marks': { marks: ['control-baseline'] } },
    })
    session.handleProjectionFrame({
      type: 'projection', sessionId: SID, key: 'test/marks', value: { marks: ['last-frame'] }, seq: 3,
    })
    history.resolve(ok({
      records: entries(plainTurn(0, 0, 'a', 'b')) as never[], hasMore: false,
      projections: { asOfSeq: 1, values: { 'test/marks': { marks: ['opening'] } } },
    } as never))
    await opening
    expect(session.projections.get('test/marks')).toEqual({ marks: ['last-frame'] })
  })

  it('keeps a newer exact opening over an older captured control baseline', async () => {
    const api = new FakeApiClient()
    const session = new Session(SID, fakeRemote(api))
    const history = deferred<Awaited<ReturnType<FakeApiClient['onHistory']>>>()
    api.onHistory = () => history.promise

    const opening = session.open()
    session.replaceProjectionBaseline({
      asOfSeq: 5, values: { 'test/marks': { marks: ['control-5'] } },
    })
    session.handleProjectionFrame({
      type: 'projection', sessionId: SID, key: 'stale', value: 'frame-6', seq: 6,
    })
    history.resolve(ok({
      records: entries(plainTurn(0, 0, 'a', 'b')) as never[], hasMore: false,
      projections: {
        asOfSeq: 10,
        values: {
          'test/marks': { marks: ['opening-10'] },
          'opening-only': 'present',
        },
      },
    } as never))
    await opening

    expect(session.projections.values()).toEqual({
      'test/marks': { marks: ['opening-10'] },
      'opening-only': 'present',
    })
  })

  it('uses the latest captured baseline generation before merging later frames', async () => {
    const api = new FakeApiClient()
    const session = new Session(SID, fakeRemote(api))
    const history = deferred<Awaited<ReturnType<FakeApiClient['onHistory']>>>()
    api.onHistory = () => history.promise

    const opening = session.open()
    session.replaceProjectionBaseline({
      asOfSeq: 12, values: { 'test/marks': { marks: ['superseded-control-12'] } },
    })
    session.handleProjectionFrame({
      type: 'projection', sessionId: SID, key: 'superseded', value: 'frame-13', seq: 13,
    })
    session.replaceProjectionBaseline({
      asOfSeq: 8, values: { 'test/marks': { marks: ['latest-control-8'] } },
    })
    session.handleProjectionFrame({
      type: 'projection', sessionId: SID, key: 'test/marks', value: { marks: ['frame-11'] }, seq: 11,
    })
    history.resolve(ok({
      records: entries(plainTurn(0, 0, 'a', 'b')) as never[], hasMore: false,
      projections: {
        asOfSeq: 10,
        values: {
          'test/marks': { marks: ['opening-10'] },
          'opening-only': 'present',
        },
      },
    } as never))
    await opening

    expect(session.projections.values()).toEqual({
      'test/marks': { marks: ['frame-11'] },
      'opening-only': 'present',
    })
  })

  it('ignores a list hint after the exact baseline is installed but before open settles', async () => {
    const api = new FakeApiClient()
    const session = new Session(SID, fakeRemote(api))
    api.onHistory = () => Promise.resolve(ok({
      records: entries(plainTurn(0, 0, 'a', 'b')) as never[], hasMore: false,
      projections: { asOfSeq: 2, values: { 'test/marks': { marks: ['exact'] } } },
    } as never))
    const unsubscribe = session.eventSource.subscribe(() => {
      expect(session.getSnapshot().openState).toBe('loading')
      session.handleProjectionHint({
        asOfSeq: 99, values: { 'test/marks': { marks: ['late-hint'] } },
      })
    })
    await session.open()
    unsubscribe()
    expect(session.projections.get('test/marks')).toEqual({ marks: ['exact'] })
  })

  it('keeps normally applied control state on failure without replaying the failed capture into a later open', async () => {
    const api = new FakeApiClient()
    const first = deferred<Awaited<ReturnType<FakeApiClient['onHistory']>>>()
    api.onHistory = () => first.promise
    const session = new Session(SID, fakeRemote(api))
    const failedOpen = session.open()
    session.handleProjectionFrame({
      type: 'projection', sessionId: SID, key: 'test/marks', value: { marks: ['during-failure'] }, seq: 3,
    })
    first.resolve(err({ code: 'session-not-found', message: 'gone', details: { sessionId: SID } }))
    await failedOpen
    expect(session.projections.get('test/marks')).toEqual({ marks: ['during-failure'] })

    api.onHistory = () => Promise.resolve(ok({
      records: entries(plainTurn(0, 0, 'a', 'b')) as never[], hasMore: false,
      projections: { asOfSeq: 2, values: { 'test/marks': { marks: ['later-open'] } } },
    } as never))
    await session.open()
    expect(session.projections.get('test/marks')).toEqual({ marks: ['later-open'] })
  })

  it('replays frames received while a carrier reconnect waits for its replacement snapshot', async () => {
    const api = new FakeApiClient()
    const session = new Session(SID, fakeRemote(api))
    api.onHistory = () => Promise.resolve(ok({
      records: entries(plainTurn(0, 0, 'a', 'b')) as never[], hasMore: false,
      projections: { asOfSeq: 2, values: { 'test/marks': { marks: ['first'] } } },
    } as never))
    await session.open()

    const replacement = deferred<Awaited<ReturnType<FakeApiClient['onHistory']>>>()
    api.onHistory = () => replacement.promise
    api.failStreams(new RemoteStreamCarrierError('carrier lost'))
    await vi.waitFor(() => { expect(api.callsOf('session.follow')).toHaveLength(2) })
    session.handleProjectionFrame({
      type: 'projection', sessionId: SID, key: 'test/marks', value: { marks: ['during-retry'] }, seq: 3,
    })
    replacement.resolve(ok({
      records: entries(plainTurn(0, 0, 'a', 'b')) as never[], hasMore: false,
      projections: { asOfSeq: 2, values: { 'test/marks': { marks: ['replacement'] } } },
    } as never))
    await vi.waitFor(() => {
      expect(session.projections.get('test/marks')).toEqual({ marks: ['during-retry'] })
    })
  })
})

describe('manager frame routing', () => {
  const sid = (s: string): SessionId => s as SessionId

  it('lands projection frames before instantiation and the Session adopts the same store', async () => {
    const api = new FakeApiClient()
    const manager = new SessionManager(fakeRemote(api))
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
    const manager = new SessionManager(fakeRemote(api))
    api.onList = () => Promise.resolve(ok({
      items: [{ sessionId: sid('s1'), updatedAt: 1, running: false, blank: false }],
    }) as never)
    await manager.refreshList()
    manager.get(sid('s1'))
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
    const manager = new SessionManager(fakeRemote(api))
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

  it('keeps late list and session-added cache hints out of an already opened Session', async () => {
    const api = new FakeApiClient()
    const manager = new SessionManager(fakeRemote(api))
    const sessionId = sid('s1')
    api.onHistory = () => Promise.resolve(ok({
      records: entries(plainTurn(0, 0, 'a', 'b')) as never[], hasMore: false,
      projections: { asOfSeq: 2, values: { 'test/marks': { marks: ['exact'] } } },
    } as never))
    const session = manager.get(sessionId)
    await session.open()

    api.onList = () => Promise.resolve(ok({
      items: [{
        sessionId, updatedAt: 1, running: false, blank: false,
        projections: { asOfSeq: 99, values: { 'test/marks': { marks: ['list-hint'] } } },
      }],
    }) as never)
    await manager.refreshList()
    manager.handleSessionAdded({
      sessionId, updatedAt: 2, running: false, blank: false,
      projections: { asOfSeq: 100, values: { 'test/marks': { marks: ['added-hint'] } } },
    })
    expect(session.projections.get('test/marks')).toEqual({ marks: ['exact'] })
  })

  it('drops the projection store with the removed session', async () => {
    const api = new FakeApiClient()
    const manager = new SessionManager(fakeRemote(api))
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
