/**
 * SessionProjectionRegistry unit drive: eager apply on committed events with
 * lazy cell build (registration after events, session after registration),
 * the Object.is no-change gate (same reference ⇒ zero change-feed work),
 * snapshot consistency (asOfSeq = last event seq; values from the watermark
 * cache), duplicate-key rejection, stateVersion validation, and effect-tied
 * removal of registrations and change listeners (HMR safety).
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    'test/marks': MarksState
    'test/count': number
    'test/buffered': { marks: string[]; draft: string }
    'test/label': string
  }

  interface SessionProjectionMap {
    'test/marks': { marks: string[] }
    'test/buffered': string[]
    'test/label': string
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'test/mark': { marks: string[] }
  }
}

type MarksState = { marks: string[] } | null
const RESTORE_HEADER: SessionHeader = {
  version: 0,
  id: SessionId('projection-restore'),
  createdAt: 0,
}
/** Whole-value unit: latest test/mark event wins; unrelated events return the same reference. */
const marksUnit = (): Omit<ProjectionDefinition<'test/marks', MarksState>, 'wire'>
  & { wire: NonNullable<ProjectionDefinition<'test/marks', MarksState>['wire']> } => ({
  key: 'test/marks',
  stateSchema: z.object({ marks: z.array(z.string()) }).nullable(),
  init: () => null,
  apply: (state, event) => (event.type === 'test/mark' ? (event).data : state),
  wire: {
    viewSchema: z.object({ marks: z.array(z.string()) }),
    view: state => state ?? { marks: [] },
  },
  stateVersion: 1,
})

/** Host-only counting unit over every event — state changes on each apply. */
const countUnit = (): ProjectionDefinition<'test/count', number> => ({
  key: 'test/count',
  stateSchema: z.number().int().nonnegative(),
  init: () => 0,
  apply: state => state + 1,
  stateVersion: 1,
})

async function harness(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  return { ctx, session: ctx.sessions.create() }
}

const mark = (session: Session, marks: string[]): SessionEvent =>
  session.append('test/mark', { marks })

describe('SessionProjectionRegistry drive', () => {
  it('drives a registered unit over committed events and snapshots the current value', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(marksUnit())
    mark(session, ['a'])
    mark(session, ['a', 'b'])
    const snapshot = ctx.sessionProjections.snapshot(session)
    expect(snapshot.values['test/marks']).toEqual({ marks: ['a', 'b'] })
    expect(snapshot.asOfSeq).toBe(session.seq - 1)
  })

  it('builds the cell lazily from the full log for a unit registered after events flowed', async () => {
    const { ctx, session } = await harness()
    mark(session, ['pre-registration'])
    ctx.sessionProjections.register(marksUnit())
    expect(ctx.sessionProjections.snapshot(session).values['test/marks']).toEqual({ marks: ['pre-registration'] })
    // The lazily-built cell then continues on the live drive path.
    mark(session, ['after'])
    expect(ctx.sessionProjections.snapshot(session).values['test/marks']).toEqual({ marks: ['after'] })
  })

  it('serves init-derived state and asOfSeq -1 for an empty log', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(marksUnit())
    const snapshot = ctx.sessionProjections.snapshot(session)
    expect(snapshot.asOfSeq).toBe(-1)
    expect(snapshot.values['test/marks']).toEqual({ marks: [] })
  })

  it('notifies onChanged with the validated view and the causing seq, and skips same-reference applies', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(marksUnit())
    const seen: { key: string; value: unknown; seq: number; sessionId: string }[] = []
    ctx.sessionProjections.onChanged((changedSession, key, value, seq) => {
      seen.push({ key, value, seq, sessionId: String(changedSession.id) })
    })
    const event = mark(session, ['a'])
    // Non-matching event: apply returns the same reference — no notification.
    session.append('turn/start', { turn: 1 })
    expect(seen).toEqual([{ key: 'test/marks', value: { marks: ['a'] }, seq: event.seq, sessionId: String(session.id) }])
  })

  it('keeps the feed quiet while a changed state serves an identity-stable view (draft buffering)', async () => {
    const { ctx, session } = await harness()
    // Unit buffering a working field beside its wire array: the view projects
    // only `marks`, whose identity survives draft-only applies.
    ctx.sessionProjections.register({
      key: 'test/buffered',
      stateSchema: z.object({ marks: z.array(z.string()), draft: z.string() }),
      init: () => ({ marks: [], draft: '' }),
      apply: (state, event) => {
        if (event.type === 'test/mark') return { marks: event.data.marks, draft: '' }
        if (event.type === 'turn/start') return { marks: state.marks, draft: `draft-${String(event.seq)}` }
        return state
      },
      wire: { viewSchema: z.array(z.string()), view: state => state.marks },
      stateVersion: 1,
    })
    const seen: { value: unknown; seq: number }[] = []
    ctx.sessionProjections.onChanged((_session, key, value, seq) => {
      if (key === 'test/buffered') seen.push({ value, seq })
    })
    const first = mark(session, ['a'])
    // Draft-only applies change the state reference but not the served view.
    session.append('turn/start', { turn: 1 })
    session.append('turn/start', { turn: 2 })
    const second = mark(session, ['a', 'b'])
    expect(seen).toEqual([
      { value: ['a'], seq: first.seq },
      { value: ['a', 'b'], seq: second.seq },
    ])
    // The quiet applies still advanced the state itself.
    expect(ctx.sessionProjections.stateOf(session, 'test/buffered')?.draft).toBe('')
    expect(ctx.sessionProjections.snapshot(session).values['test/buffered']).toEqual(['a', 'b'])
  })

  it("computes each distinct state's view once: the memo serves previous states to the gate and snapshots", async () => {
    const { ctx, session } = await harness()
    let viewCalls = 0
    ctx.sessionProjections.register({
      key: 'test/buffered',
      stateSchema: z.object({ marks: z.array(z.string()), draft: z.string() }),
      init: () => ({ marks: [], draft: '' }),
      apply: (state, event) => {
        if (event.type === 'test/mark') return { marks: event.data.marks, draft: '' }
        if (event.type === 'turn/start') return { marks: state.marks, draft: `draft-${String(event.seq)}` }
        return state
      },
      wire: {
        viewSchema: z.array(z.string()),
        view: (state) => {
          viewCalls += 1
          return state.marks
        },
      },
      stateVersion: 1,
    })
    const seen: unknown[] = []
    ctx.sessionProjections.onChanged((_session, key, value) => {
      if (key === 'test/buffered') seen.push(value)
    })
    // First change touches two never-seen states (init and next): two calls.
    mark(session, ['a'])
    expect(viewCalls).toBe(2)
    // Draft-only change: the new state computes, the previous is a memo hit.
    session.append('turn/start', { turn: 1 })
    expect(viewCalls).toBe(3)
    mark(session, ['a', 'b'])
    expect(viewCalls).toBe(4)
    expect(seen).toEqual([['a'], ['a', 'b']])
    // Snapshot reads reuse the same memo instead of recomputing the view.
    expect(ctx.sessionProjections.snapshot(session).values['test/buffered']).toEqual(['a', 'b'])
    expect(viewCalls).toBe(4)
  })

  it('keeps dedup honest across listener generations: a return to an old value after an unobserved change still fires', async () => {
    const { ctx, session } = await harness()
    // A primitive-valued view compares by value under Object.is (the title
    // unit's shape), which is exactly where remembering a delivered value —
    // instead of comparing the two states in hand — would silence a real
    // transition.
    ctx.sessionProjections.register({
      key: 'test/label',
      stateSchema: z.string(),
      init: () => '',
      apply: (state, event) => (event.type === 'test/mark' ? event.data.marks[0] ?? '' : state),
      wire: { viewSchema: z.string(), view: state => state },
      stateVersion: 1,
    })
    const first: string[] = []
    const stop = ctx.sessionProjections.onChanged((_session, key, value) => {
      if (key === 'test/label') first.push(value as string)
    })
    mark(session, ['A'])
    stop()
    // Unobserved transition away from 'A'…
    mark(session, ['B'])
    // …then a new listener generation subscribes and the value returns:
    // dedup memory frozen at the delivered 'A' would silence this delivery;
    // the per-step previous-state comparison sees 'B' → 'A' and fires.
    const second: string[] = []
    ctx.sessionProjections.onChanged((_session, key, value) => {
      if (key === 'test/label') second.push(value as string)
    })
    mark(session, ['A'])
    expect(first).toEqual(['A'])
    expect(second).toEqual(['A'])
  })

  it('drives independently per session (cells are per-session watermarks)', async () => {
    const { ctx, session } = await harness()
    const other = ctx.sessions.create()
    ctx.sessionProjections.register(marksUnit())
    mark(session, ['one'])
    mark(other, ['two'])
    expect(ctx.sessionProjections.snapshot(session).values['test/marks']).toEqual({ marks: ['one'] })
    expect(ctx.sessionProjections.snapshot(other).values['test/marks']).toEqual({ marks: ['two'] })
  })

  it('updates host-only units without publishing them to wire listeners', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(marksUnit())
    ctx.sessionProjections.register(countUnit())
    const changedKeys: string[] = []
    ctx.sessionProjections.onChanged((_session, key) => {
      changedKeys.push(key)
    })
    session.append('turn/start', { turn: 1 })
    expect(changedKeys).toEqual([])
    expect(ctx.sessionProjections.stateOf(session, 'test/count')).toBe(1)
    expect(ctx.sessionProjections.snapshot(session).values).toEqual({ 'test/marks': { marks: [] } })
  })

  it('shares one unit between registrants of the same key', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(marksUnit())

    // One definition already serves every session (cells are keyed by
    // Session), and registrants are per-session now: an agent preset mounts
    // the same tool package once per agent.
    expect(() => ctx.sessionProjections.register(marksUnit())).not.toThrow()
    mark(session, ['kept'])
    expect(ctx.sessionProjections.snapshot(session).values['test/marks']).toEqual({ marks: ['kept'] })
  })

  it('keeps the unit until the last registrant releases it', async () => {
    const { ctx, session } = await harness()
    const first = ctx.sessionProjections.register(marksUnit())
    const second = ctx.sessionProjections.register(marksUnit())
    mark(session, ['kept'])

    first()

    // The regression this counts against: without last-release semantics, one
    // session ending strips the projection from every other live session,
    // because the first registrant owns the only disposer.
    expect(ctx.sessionProjections.snapshot(session).values['test/marks']).toEqual({ marks: ['kept'] })
    second()
    expect(ctx.sessionProjections.snapshot(session).values).toEqual({})
  })

  it('refuses to share a key across a stateVersion change', async () => {
    const { ctx } = await harness()
    ctx.sessionProjections.register(marksUnit())

    // The one incompatibility a runtime comparison can name: the versioned
    // contract says the cached state shape differs, so the two cannot share
    // cells. Everything else about a definition is functions.
    expect(() => ctx.sessionProjections.register({ ...marksUnit(), stateVersion: 9 }))
      .toThrow(/already registered at stateVersion 1; refusing to share it with stateVersion 9/)
  })

  it('rejects a non-integer or negative stateVersion at register time', async () => {
    const { ctx } = await harness()
    expect(() => ctx.sessionProjections.register({ ...marksUnit(), stateVersion: -1 })).toThrow(/stateVersion/)
    expect(() => ctx.sessionProjections.register({ ...marksUnit(), stateVersion: 1.5 })).toThrow(/stateVersion/)
  })

  it('register() disposer removes the key (with its cells) and frees it for re-registration', async () => {
    const { ctx, session } = await harness()
    const dispose = ctx.sessionProjections.register(marksUnit())
    mark(session, ['cached'])
    dispose()
    expect(ctx.sessionProjections.snapshot(session).values).toEqual({})
    ctx.sessionProjections.register(marksUnit())
    // Fresh registration rebuilds from the log, not from a stale cell.
    expect(ctx.sessionProjections.snapshot(session).values['test/marks']).toEqual({ marks: ['cached'] })
  })

  it('removes registrations and change listeners when their owning fiber unloads (HMR safety)', async () => {
    const { ctx, session } = await harness()
    const notifications: string[] = []
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.sessionProjections.register(marksUnit())
      inner.sessionProjections.onChanged((_session, key) => {
        notifications.push(key)
      })
    }, { inject: ['sessionProjections'] }))
    mark(session, ['live'])
    expect(notifications).toEqual(['test/marks'])
    await fiber.dispose()
    mark(session, ['after-dispose'])
    expect(notifications).toEqual(['test/marks'])
    expect(ctx.sessionProjections.snapshot(session).values).toEqual({})
  })

  it('snapshot serves client views and excludes host-only state', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(marksUnit())
    ctx.sessionProjections.register(countUnit())
    mark(session, ['a', 'b'])
    const values = ctx.sessionProjections.snapshot(session).values
    expect(values['test/marks']).toEqual({ marks: ['a', 'b'] })
    expect('test/count' in values).toBe(false)
    expect(ctx.sessionProjections.stateOf(session, 'test/count')).toBe(1)
    expect('test/unregistered' in values).toBe(false)
  })

  it('checkpoints every persisted unit with its stateVersion and per-cell watermark', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(marksUnit())
    ctx.sessionProjections.register({ ...countUnit(), stateVersion: 7 })
    const markEvent = mark(session, ['a'])
    const rows = ctx.sessionProjections.checkpoint(session)
    expect(rows['test/marks']).toEqual({ ver: 1, seq: markEvent.seq, val: { marks: ['a'] } })
    expect(rows['test/count']).toEqual({ ver: 7, seq: markEvent.seq, val: 1 })
    // Empty log: init-derived state at watermark -1.
    const fresh = ctx.sessions.create()
    expect(ctx.sessionProjections.checkpoint(fresh)['test/marks']).toEqual({ ver: 1, seq: -1, val: null })
  })

  it('checkpoint states are detached clones — mutating them cannot corrupt the watermark cache', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(marksUnit())
    mark(session, ['a'])
    const rows = ctx.sessionProjections.checkpoint(session)
    // Hostile (or merely careless) consumer mutates the handed-out state.
    ;(rows['test/marks']?.val as { marks: string[] }).marks.push('INJECTED')
    // The registry's authoritative cell is untouched: snapshot and a fresh
    // checkpoint both still serve the committed value.
    expect(ctx.sessionProjections.snapshot(session).values['test/marks']).toEqual({ marks: ['a'] })
    expect(ctx.sessionProjections.checkpoint(session)['test/marks']?.val).toEqual({ marks: ['a'] })
  })

  it('restoreFloor anchors one below the lowest usable watermark and at 0 for missing or mismatched rows', async () => {
    const { ctx } = await harness()
    expect(ctx.sessionProjections.restoreFloor({})).toBeUndefined() // no unit registered
    ctx.sessionProjections.register(marksUnit())
    ctx.sessionProjections.register(countUnit())
    expect(ctx.sessionProjections.restoreFloor({})).toBe(0)
    // Lowest usable watermark is count's 5 → the anchored tail starts AT 5
    // (one below the first needed seq 6), so the read proves seq 5 still exists.
    expect(ctx.sessionProjections.restoreFloor({
      'test/marks': { ver: 1, seq: 10, val: { marks: [] } },
      'test/count': { ver: 1, seq: 5, val: 6 },
    })).toBe(5)
    // A version-mismatched row forces that key back to a full refold.
    expect(ctx.sessionProjections.restoreFloor({
      'test/marks': { ver: 2, seq: 10, val: { marks: [] } },
      'test/count': { ver: 1, seq: 5, val: 6 },
    })).toBe(0)
    // A fresh (-1) row still needs the whole tail from 0.
    expect(ctx.sessionProjections.restoreFloor({
      'test/marks': { ver: 1, seq: -1, val: null },
      'test/count': { ver: 1, seq: -1, val: 0 },
    })).toBe(0)
  })

  it('restore folds the tail past each usable row and refolds from init on version mismatch', async () => {
    const { ctx } = await harness()
    ctx.sessionProjections.register(marksUnit())
    ctx.sessionProjections.register(countUnit())
    const tail: SessionEvent[] = [
      { type: 'test/mark', seq: 3, time: 3, data: { marks: ['new'] } },
      { type: 'turn/end', seq: 4, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    // marks row usable (watermark 2, tail starts at 3); count row mismatched — but
    // a mismatch with baseSeq > 0 cannot silently refold: it throws for a re-read.
    expect(() => ctx.sessionProjections.restore({
      'test/marks': { ver: 1, seq: 2, val: { marks: ['old'] } },
      'test/count': { ver: 99, seq: 2, val: 3 },
    }, tail, 3, RESTORE_HEADER)).toThrow(/re-read from seq 0/)
    // The full-log re-read (baseSeq 0) refolds the mismatched key from init.
    const full: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
      { type: 'test/mark', seq: 1, time: 1, data: { marks: ['old'] } },
      { type: 'test/mark', seq: 2, time: 2, data: { marks: ['old', '2'] } },
      ...tail,
    ]
    const { snapshot, checkpoint } = ctx.sessionProjections.restore({
      'test/marks': { ver: 1, seq: 2, val: { marks: ['old', '2'] } },
      'test/count': { ver: 99, seq: 2, val: 3 },
    }, full, 0, RESTORE_HEADER)
    expect(snapshot.asOfSeq).toBe(4)
    expect(snapshot.values['test/marks']).toEqual({ marks: ['new'] })
    expect('test/count' in snapshot.values).toBe(false)
    // The refreshed rows sit at the served cut, ready for a durable write-back.
    expect(checkpoint['test/marks']).toEqual({ ver: 1, seq: 4, val: { marks: ['new'] } })
    expect(checkpoint['test/count']).toEqual({ ver: 1, seq: 4, val: 5 })
  })

  it('restore over a suffix folds only past each row watermark and serves an exact empty-tail cut', async () => {
    const { ctx } = await harness()
    ctx.sessionProjections.register(marksUnit())
    ctx.sessionProjections.register(countUnit())
    const rows = {
      'test/marks': { ver: 1, seq: 4, val: { marks: ['done'] } },
      'test/count': { ver: 1, seq: 2, val: 3 },
    }
    const tail: SessionEvent[] = [
      { type: 'turn/start', seq: 3, time: 3, data: { turn: 2 } },
      { type: 'turn/end', seq: 4, time: 4, data: { turn: 2, reason: { kind: 'completed' } } },
    ]
    const { snapshot, checkpoint } = ctx.sessionProjections.restore(rows, tail, 3, RESTORE_HEADER)
    expect(snapshot.asOfSeq).toBe(4)
    // marks already covers the tail (watermark 4): nothing re-applied.
    expect(snapshot.values['test/marks']).toEqual({ marks: ['done'] })
    // count folds exactly seqs 3 and 4 on top of its checkpoint, but remains host-only.
    expect(checkpoint['test/count']).toEqual({ ver: 1, seq: 4, val: 5 })
    expect('test/count' in snapshot.values).toBe(false)

    // Empty tail (checkpoint is current): the cut sits at baseSeq - 1.
    const { snapshot: current, checkpoint: currentCheckpoint } = ctx.sessionProjections.restore({
      'test/marks': { ver: 1, seq: 4, val: { marks: ['done'] } },
      'test/count': { ver: 1, seq: 4, val: 5 },
    }, [], 5, RESTORE_HEADER)
    expect(current.asOfSeq).toBe(4)
    expect('test/count' in current.values).toBe(false)
    expect(currentCheckpoint['test/count']).toEqual({ ver: 1, seq: 4, val: 5 })
  })

  it('viewCheckpoint serves version-matching rows without any log and skips mismatched keys', async () => {
    const { ctx } = await harness()
    ctx.sessionProjections.register(marksUnit())
    ctx.sessionProjections.register(countUnit())
    const values = ctx.sessionProjections.viewCheckpoint({
      'test/marks': { ver: 1, seq: 4, val: { marks: ['stored'] } },
      'test/count': { ver: 99, seq: 4, val: 5 }, // mismatched: absent
    })
    expect(values['test/marks']).toEqual({ marks: ['stored'] })
    expect('test/count' in values).toBe(false)
    expect(ctx.sessionProjections.viewCheckpoint({})).toEqual({})
  })

  it('viewCheckpoint and restore exclude host-only state while retaining its checkpoint', async () => {
    const { ctx } = await harness()
    ctx.sessionProjections.register(marksUnit())
    ctx.sessionProjections.register(countUnit())
    const rows = {
      'test/marks': { ver: 1, seq: 4, val: { marks: ['stored'] } },
      'test/count': { ver: 1, seq: 4, val: 5 },
    }
    expect(ctx.sessionProjections.viewCheckpoint(rows)).toEqual({
      'test/marks': { marks: ['stored'] },
    })

    const restored = ctx.sessionProjections.restore(rows, [], 5, RESTORE_HEADER)
    expect(restored.snapshot.values).toEqual({
      'test/marks': { marks: ['stored'] },
    })
    expect(restored.checkpoint['test/count']).toEqual(rows['test/count'])
  })

  it('rejects version-matching rows whose state no longer matches the registered schema', async () => {
    const { ctx } = await harness()
    ctx.sessionProjections.register(marksUnit())
    const drifted = {
      'test/marks': { ver: 1, seq: 2, val: { marks: 'not-an-array' } },
    }

    expect(ctx.sessionProjections.viewCheckpoint(drifted)).toEqual({})
    expect(() => ctx.sessionProjections.restore(drifted, [], 3, RESTORE_HEADER)).toThrow()
  })

  it('restore rejects a row claiming events past the supplied log end (shrunk log ⇒ re-read)', async () => {
    const { ctx } = await harness()
    ctx.sessionProjections.register(countUnit())
    const rows = { 'test/count': { ver: 1, seq: 9, val: 10 } }
    // The anchored floor sits ON the watermark, so the tail read must return
    // at least seq 9 from an intact log…
    const floor = ctx.sessionProjections.restoreFloor(rows)
    expect(floor).toBe(9)
    // …an intact log serves the anchor event and the checkpoint stands as-is.
    const anchor: SessionEvent = { type: 'turn/end', seq: 9, time: 9, data: { turn: 2, reason: { kind: 'completed' } } }
    const anchored = ctx.sessionProjections.restore(rows, [anchor], 9, RESTORE_HEADER)
    expect(anchored.snapshot.values).toEqual({})
    expect(anchored.checkpoint['test/count']).toEqual({ ver: 1, seq: 9, val: 10 })
    // …while a log crash-repaired down to fewer events returns an empty tail:
    // the row overreaches the proven end and a tail read cannot fix this key.
    expect(() => ctx.sessionProjections.restore(rows, [], 9, RESTORE_HEADER)).toThrow(/re-read from seq 0/)
    // The full re-read discards the overreaching row and refolds from init.
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const { snapshot, checkpoint } = ctx.sessionProjections.restore(rows, events, 0, RESTORE_HEADER)
    expect(snapshot.asOfSeq).toBe(1)
    expect(snapshot.values).toEqual({})
    expect(checkpoint['test/count']).toEqual({ ver: 1, seq: 1, val: 2 })
  })

  it('fails loud when a unit view violates its own schema (async unit output is unrepresentable)', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register({
      key: 'test/marks',
      stateSchema: z.object({ marks: z.array(z.string()) }).nullable(),
      init: () => null as MarksState,
      apply: state => state,
      wire: {
        viewSchema: z.object({ marks: z.array(z.string()) }),
        // A Promise (what an accidentally-async view would return) is not the
        // declared shape: the boundary parse rejects it before it leaves.
        view: () => Promise.resolve({ marks: [] }) as never,
      },
      stateVersion: 1,
    })
    expect(() => ctx.sessionProjections.snapshot(session)).toThrow()
  })
})
