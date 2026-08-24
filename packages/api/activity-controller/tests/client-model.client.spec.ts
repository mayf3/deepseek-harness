import { describe, expect, it } from 'vitest'
import { ClientActivityModel } from '../src/client/model.ts'
import type { ActivityId, ActivityRow } from '../src/types.ts'

function row(over: Partial<ActivityRow> = {}): ActivityRow {
  return {
    id: 'bash-1' as ActivityId,
    kind: 'bash',
    label: 'build',
    sessionId: 'alice' as ActivityRow['sessionId'],
    status: 'running',
    startedAt: 1,
    outputTotal: 0,
    ...over,
  } as ActivityRow
}

/** A row with no owner session, as the unowned bucket carries them. */
function unownedRow(over: Partial<ActivityRow> = {}): ActivityRow {
  const { sessionId: _drop, ...rest } = row(over)
  return rest
}

const ID = 'bash-1' as ActivityId

function opened(model: ClientActivityModel, over: Partial<{ from: number; earliest: number; total: number }> = {}): void {
  model.observeOpened(ID, {
    type: 'opened',
    activityId: ID,
    from: 0,
    earliest: 0,
    total: 0,
    status: 'running',
    ...over,
  })
}

describe('ClientActivityModel roster', () => {
  it('folds baselines into per-session buckets and reports readiness', () => {
    const model = new ClientActivityModel()
    expect(model.getSnapshot().phase).toBe('pending')
    model.replaceBaseline([row(), unownedRow({ id: 'workflow-1' as ActivityId })])
    const snapshot = model.getSnapshot()
    expect(snapshot.phase).toBe('ready')
    expect(snapshot.rowsBySession['alice']).toHaveLength(1)
    expect(snapshot.rowsBySession['']).toHaveLength(1)
  })

  it('replaces buckets wholesale and drops emptied keys', () => {
    const model = new ClientActivityModel()
    model.replaceBaseline([row()])
    model.replaceBucket('alice', [row({ status: 'completed', finishedAt: 2 })])
    expect(model.getSnapshot().rowsBySession['alice']?.[0]?.status).toBe('completed')
    model.replaceBucket('alice', [])
    expect('alice' in model.getSnapshot().rowsBySession).toBe(false)
    model.replaceBucket(undefined, [unownedRow()])
    expect(model.getSnapshot().rowsBySession['']).toHaveLength(1)
  })

  it('keeps snapshot identity stable between changes and notifies subscribers', () => {
    const model = new ClientActivityModel()
    let notified = 0
    const unsubscribe = model.subscribe(() => { notified += 1 })
    const before = model.getSnapshot()
    expect(model.getSnapshot()).toBe(before)
    model.replaceBaseline([row()])
    expect(notified).toBe(1)
    expect(model.getSnapshot()).not.toBe(before)
    unsubscribe()
    model.replaceBucket('alice', [])
    expect(notified).toBe(1)
  })
})

describe('ClientActivityModel observation', () => {
  it('accumulates output, advances the resume cursor, and settles on status', () => {
    const model = new ClientActivityModel()
    opened(model)
    expect(model.cursorOf(ID)).toBe(0)
    model.observeOutput(ID, { type: 'output', chunks: [{ at: 0, text: 'a' }, { at: 1, text: 'b' }], next: 2 })
    model.observeOutput(ID, { type: 'output', chunks: [{ at: 2, text: 'c' }], next: 3 })
    expect(model.cursorOf(ID)).toBe(3)
    const view = model.getSnapshot().observed[String(ID)]
    expect(view?.text).toBe('abc')
    expect(view?.streaming).toBe(true)
    model.observeStatus(ID, { type: 'status', status: 'completed', detail: 'exit code: 0' })
    const settled = model.getSnapshot().observed[String(ID)]
    expect(settled?.streaming).toBe(false)
    expect(settled?.status).toBe('completed')
    expect(settled?.detail).toBe('exit code: 0')
  })

  it('marks gaps from lossy frames, gap chunks, and a resume behind the retained head', () => {
    const model = new ClientActivityModel()
    opened(model, { from: 4, earliest: 8, total: 10 })
    expect(model.getSnapshot().observed[String(ID)]?.gapBefore).toBe(true)

    const clean = new ClientActivityModel()
    opened(clean)
    clean.observeOutput(ID, { type: 'output', chunks: [{ at: 0, text: 'x', gapBefore: true }], next: 1 })
    expect(clean.getSnapshot().observed[String(ID)]?.gapBefore).toBe(true)

    const lossy = new ClientActivityModel()
    opened(lossy)
    lossy.observeOutput(ID, { type: 'output', chunks: [], next: 5, lossy: true })
    expect(lossy.getSnapshot().observed[String(ID)]?.gapBefore).toBe(true)
  })

  it('marks a fresh observation anchored past the evicted head', () => {
    // Fresh observations anchor at the registry's earliest retained byte, so
    // from === earliest > 0 means the head was already discarded.
    const fresh = new ClientActivityModel()
    opened(fresh, { from: 60_240, earliest: 60_240, total: 321_328 })
    expect(fresh.getSnapshot().observed[String(ID)]?.gapBefore).toBe(true)

    // A retry that accumulated no text yet earns the mark the same way.
    const retried = new ClientActivityModel()
    opened(retried)
    expect(retried.getSnapshot().observed[String(ID)]?.gapBefore).toBe(false)
    opened(retried, { from: 6, earliest: 6, total: 6 })
    expect(retried.getSnapshot().observed[String(ID)]?.gapBefore).toBe(true)
  })

  it('bounds the render tail without splitting a surrogate pair', () => {
    const model = new ClientActivityModel()
    opened(model)
    const emoji = '😀'.repeat((64 * 1024) + 8)
    model.observeOutput(ID, { type: 'output', chunks: [{ at: 0, text: emoji }], next: emoji.length * 2 })
    const view = model.getSnapshot().observed[String(ID)]
    expect(view?.gapBefore).toBe(true)
    expect(view!.text.length).toBeLessThanOrEqual(128 * 1024)
    // The bound landed between pairs: the surviving text still round-trips.
    expect(/^(?:😀)+$/u.test(view!.text)).toBe(true)
  })

  it('carries the anchor detail and trims a plain-ASCII tail without a boundary shift', () => {
    const model = new ClientActivityModel()
    model.observeOpened(ID, {
      type: 'opened', activityId: ID, from: 0, earliest: 0, total: 0, status: 'running', detail: 'exit soon',
    })
    expect(model.getSnapshot().observed[String(ID)]?.detail).toBe('exit soon')
    const long = 'x'.repeat((128 * 1024) + 5)
    model.observeOutput(ID, { type: 'output', chunks: [{ at: 0, text: long }], next: long.length })
    const view = model.getSnapshot().observed[String(ID)]
    expect(view?.text.length).toBe(128 * 1024)
    expect(view?.gapBefore).toBe(true)
  })

  it('advances the cut past a low surrogate landing exactly on the bound', () => {
    const model = new ClientActivityModel()
    opened(model)
    // 'z' + one emoji + odd ASCII tail puts a low surrogate exactly at the cut index.
    const text = 'z😀' + 'a'.repeat((128 * 1024) - 1)
    model.observeOutput(ID, { type: 'output', chunks: [{ at: 0, text }], next: text.length })
    const view = model.getSnapshot().observed[String(ID)]
    expect(view?.text.length).toBe((128 * 1024) - 1)
    expect(view?.text.startsWith('a')).toBe(true)
  })

  it('preserves accumulated text across a reconnect anchor and clears on stop', () => {
    const model = new ClientActivityModel()
    opened(model)
    model.observeOutput(ID, { type: 'output', chunks: [{ at: 0, text: 'kept' }], next: 4 })
    opened(model, { from: 4, earliest: 0, total: 4 })
    expect(model.getSnapshot().observed[String(ID)]?.text).toBe('kept')
    model.observeStopped(ID)
    expect(model.getSnapshot().observed[String(ID)]).toBeUndefined()
    expect(model.cursorOf(ID)).toBeUndefined()
    // A second stop is inert.
    model.observeStopped(ID)
  })

  it('records a terminal stream failure on the live view', () => {
    const model = new ClientActivityModel()
    opened(model)
    model.observeFailed(ID, new Error('carrier gone'))
    const view = model.getSnapshot().observed[String(ID)]
    expect(view?.streaming).toBe(false)
    expect(view?.error).toContain('carrier gone')
    // A failure for an untracked id is inert.
    model.observeFailed('bash-9' as ActivityId, new Error('ignored'))
  })
})
