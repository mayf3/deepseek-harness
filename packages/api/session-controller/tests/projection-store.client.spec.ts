/**
 * Projection value-store precedence plus the minimal Session opening lifecycle
 * that creates and settles store-owned reconciliation tokens.
 */
import { describe, expect, it, vi } from 'vitest'
import { RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { ProjectionValueStore } from '../src/client/sessions/projection-store.ts'
import { Session } from '../src/client/sessions/session.ts'
import { FakeApiClient, deferred, err, fakeRemote, ok } from './fake-api.client.ts'
import { entries, plainTurn } from './event-script.client.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    'test/marks': { marks: string[] }
  }
}

const SID = 'fk-s1' as SessionId

describe('Session projection value semantics', () => {
  it('reads undefined until a value lands and keeps stable observable faces', () => {
    const store = new ProjectionValueStore()
    expect(store.get('test/marks')).toBeUndefined()
    expect(store.faceOf('test/marks').getSnapshot()).toBeUndefined()
    expect(store.faceOf('test/marks')).toBe(store.faceOf('test/marks'))
  })

  it('lets the first authoritative frame replace a newer hint, then uses higher-seq-wins', () => {
    const store = new ProjectionValueStore()
    store.prewarm({
      asOfSeq: 9,
      values: { 'test/marks': { marks: ['hint-9'] }, 'hint-only': 'hint' },
    })
    store.prewarm({
      asOfSeq: 8,
      values: { 'test/marks': { marks: ['older-hint'] } },
    })

    store.apply('test/marks', { marks: ['frame-3'] }, 3)
    store.prewarm({
      asOfSeq: 12,
      values: { 'test/marks': { marks: ['late-hint'] }, 'other-hint': 'other' },
    })
    store.apply('test/marks', { marks: ['equal-frame'] }, 3)
    store.apply('test/marks', { marks: ['newer-frame'] }, 4)

    expect(store.values()).toEqual({
      'test/marks': { marks: ['newer-frame'] },
      'hint-only': 'hint',
      'other-hint': 'other',
    })
  })

  it('opening replaces pre-opening state and retains only newer post-token frames', () => {
    const store = new ProjectionValueStore()
    store.prewarm({ asOfSeq: 20, values: { 'test/marks': { marks: ['hint'] } } })
    store.apply('pre-opening', 'old-frame', 30)
    const opening = store.beginOpening()
    store.apply('test/marks', { marks: ['post-token'] }, 3)
    store.apply('discarded', 'at-cut', 10)
    store.apply('retained', 'new-frame', 11)

    store.completeOpening(opening, {
      asOfSeq: 10,
      values: {
        'test/marks': { marks: ['opening'] },
        'opening-only': 'present',
      },
    })

    expect(store.values()).toEqual({
      'test/marks': { marks: ['opening'] },
      'opening-only': 'present',
      retained: 'new-frame',
    })
  })

  it('a control baseline exactly replaces equal-sequence and omitted rows', () => {
    const store = new ProjectionValueStore()
    store.apply('title', 'transient', 1)
    store.apply('omitted', 'transient', 1)

    store.replaceControlBaseline({ asOfSeq: 1, values: { title: null } })

    expect(store.values()).toEqual({ title: null })
    store.apply('title', 'equal-frame', 1)
    expect(store.get('title')).toBeNull()
    store.apply('title', 'durable-frame', 2)
    expect(store.get('title')).toBe('durable-frame')
  })

  it('an equal or newer control baseline received during opening wins', () => {
    const store = new ProjectionValueStore()
    const opening = store.beginOpening()
    store.replaceControlBaseline({
      asOfSeq: 5,
      values: { 'test/marks': { marks: ['control'] }, 'control-only': 'present' },
    })
    store.apply('test/marks', { marks: ['after-control'] }, 6)

    store.completeOpening(opening, {
      asOfSeq: 5,
      values: { 'test/marks': { marks: ['opening'] }, 'opening-only': 'discarded' },
    })

    expect(store.values()).toEqual({
      'test/marks': { marks: ['after-control'] },
      'control-only': 'present',
    })
  })

  it('a newer opening replaces an older control baseline but keeps later frames', () => {
    const store = new ProjectionValueStore()
    const opening = store.beginOpening()
    store.replaceControlBaseline({
      asOfSeq: 5,
      values: { 'test/marks': { marks: ['control'] }, 'control-only': 'discarded' },
    })
    store.apply('stale-frame', 'discarded', 6)
    store.apply('retained-frame', 'present', 11)

    store.completeOpening(opening, {
      asOfSeq: 10,
      values: { 'test/marks': { marks: ['opening'] }, 'opening-only': 'present' },
    })

    expect(store.values()).toEqual({
      'test/marks': { marks: ['opening'] },
      'opening-only': 'present',
      'retained-frame': 'present',
    })
  })

  it('ignores hints after a complete baseline and rejects stale opening tokens', () => {
    const store = new ProjectionValueStore()
    const stale = store.beginOpening()
    const current = store.beginOpening()
    store.completeOpening(stale, { asOfSeq: 1, values: { stale: true } })
    expect(store.values()).toEqual({})
    store.cancelOpening(stale)
    store.completeOpening(current, { asOfSeq: 1, values: { exact: true } })
    store.prewarm({ asOfSeq: 99, values: { exact: false, late: true } })
    expect(store.values()).toEqual({ exact: true })
  })

  it('a canceled opening makes its frames pre-opening for the next exact cut', () => {
    const store = new ProjectionValueStore()
    const failed = store.beginOpening()
    store.apply('test/marks', { marks: ['failed-frame'] }, 3)
    store.cancelOpening(failed)
    const retry = store.beginOpening()
    store.completeOpening(retry, {
      asOfSeq: 2,
      values: { 'test/marks': { marks: ['retry'] } },
    })
    expect(store.get('test/marks')).toEqual({ marks: ['retry'] })
  })

  it('notifies accepted changes but not dropped authoritative frames', async () => {
    const store = new ProjectionValueStore()
    let keyTicks = 0
    let anyTicks = 0
    store.faceOf('test/marks').subscribe(() => { keyTicks += 1 })
    store.subscribeAny(() => { anyTicks += 1 })
    const value = { marks: ['a'] }
    store.apply('test/marks', value, 1)
    await Promise.resolve()
    expect(keyTicks).toBe(1)
    expect(anyTicks).toBe(1)
    store.apply('test/marks', { marks: ['replay'] }, 0)
    store.replaceControlBaseline({ asOfSeq: 5, values: { 'test/marks': value } })
    store.apply('test/marks', { marks: ['stale-after-baseline'] }, 4)
    await Promise.resolve()
    expect(keyTicks).toBe(1)
    expect(anyTicks).toBe(1)
    expect(store.get('test/marks')).toBe(value)
  })

  it('publishes one stable whole-value snapshot until an observable row changes', () => {
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

describe('Session opening integration', () => {
  it('retains a tentative hint when opening fails, then replaces it on retry', async () => {
    const api = new FakeApiClient()
    const projections = new ProjectionValueStore()
    projections.prewarm({ asOfSeq: 5, values: { 'test/marks': { marks: ['cached'] } } })
    const session = new Session(SID, fakeRemote(api), { projections })
    api.onHistory = () => Promise.resolve(err({
      code: 'session-not-found',
      message: 'gone',
      details: { sessionId: SID },
    }))

    await session.open()
    expect(session.getSnapshot().openState).toBe('error')
    expect(session.projections.get('test/marks')).toEqual({ marks: ['cached'] })

    api.onHistory = () => Promise.resolve(ok({
      records: entries(plainTurn(0, 0, 'a', 'b')) as never[], hasMore: false,
      projections: { asOfSeq: 2, values: { 'test/marks': { marks: ['exact'] } } },
    } as never))
    await session.open()
    expect(session.projections.get('test/marks')).toEqual({ marks: ['exact'] })
  })

  it('preserves an authoritative frame received while the opening is in flight', async () => {
    const api = new FakeApiClient()
    const history = deferred<Awaited<ReturnType<FakeApiClient['onHistory']>>>()
    api.onHistory = () => history.promise
    const session = new Session(SID, fakeRemote(api))

    const opening = session.open()
    session.projections.apply('test/marks', { marks: ['live'] }, 3)
    history.resolve(ok({
      records: entries(plainTurn(0, 0, 'a', 'b')) as never[], hasMore: false,
      projections: { asOfSeq: 2, values: { 'test/marks': { marks: ['opening'] } } },
    } as never))
    await opening

    expect(session.projections.get('test/marks')).toEqual({ marks: ['live'] })
  })

  it('starts a fresh opening token while a carrier reconnect awaits its snapshot', async () => {
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
    session.projections.apply('test/marks', { marks: ['during-retry'] }, 3)
    replacement.resolve(ok({
      records: entries(plainTurn(0, 0, 'a', 'b')) as never[], hasMore: false,
      projections: { asOfSeq: 2, values: { 'test/marks': { marks: ['replacement'] } } },
    } as never))

    await vi.waitFor(() => {
      expect(session.projections.get('test/marks')).toEqual({ marks: ['during-retry'] })
    })
  })
})
