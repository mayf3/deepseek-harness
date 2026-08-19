/**
 * SessionProjectionCache behavior: mandatory-point writes (turn/end, detach),
 * count/interval throttling between them, fail-soft durability (a failed
 * write logs and stays stale, never throws into the event path), and the
 * cold-read ladder (cached file + readFrom tail + registry restore +
 * write-back; version bump and shrunk-log rows degrade to a full re-read).
 * The durable medium is one `projection_cache.json` per session inside the
 * session's persistence directory (resolved via `sessionPersistence.locate`).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import SessionProjectionCache from '../src/index.ts'
import { checkpointRecord } from '../src/spec.ts'
import type { CheckpointRecord } from '../src/spec.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    'cache-test/marks': MarksState
    'cache-test/marks2': Map<string, string>
  }
  interface SessionProjectionMap {
    'cache-test/marks': { marks: string[] }
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'cache-test/mark': { marks: string[] }
  }

  interface OutOfBandSessionEventMap {
    'cache-test/mark': true
  }
}

type MarksState = { marks: string[] } | null
const marksUnit = (stateVersion = 1) => ({
  key: 'cache-test/marks',
  stateSchema: z.object({ marks: z.array(z.string()) }).nullable(),
  init: () => null,
  apply: (state, event) => (event.type === 'cache-test/mark' ? (event).data : state),
  wire: {
    viewSchema: z.object({ marks: z.array(z.string()) }),
    view: state => state ?? { marks: [] },
  },
  stateVersion,
}) satisfies ProjectionDefinition<'cache-test/marks', MarksState>

/** One session's cache file inside its persistence directory. */
const cachePath = (root: string, id: Session['id']): string =>
  join(root, String(id), 'projection_cache.json')

/** A persistence double serving locate + readFrom over a fixed per-id stored log (headers stamp createdAt 0). */
function fakePersistence(root: string, logs: Map<string, SessionEvent[]>) {
  const readFrom = vi.fn(async (id: SessionId, fromSeq: number) => {
    const events = logs.get(String(id))
    if (events === undefined) throw new Error(`session "${id}" not found`)
    return {
      meta: { version: 0, id, createdAt: 0 },
      events: events.filter(event => event.seq >= fromSeq),
    }
  })
  return {
    readFrom,
    locate: (meta: SessionHeader) => ({ kind: 'jsonl', path: join(root, String(meta.id), 'session.jsonl') }),
  }
}

/** Header shape for cachedSnapshot calls (fake logs stamp createdAt 0, no cwd). */
const headerOf = (id: SessionId, createdAt = 0, cwd?: string) =>
  ({ version: 0, id, createdAt, ...cwd === undefined ? {} : { cwd } })

interface HarnessOptions {
  root?: string
  config?: { writeEveryEvents: number; writeIntervalMs: number }
  stateVersion?: number
  logs?: Map<string, SessionEvent[]>
}

const contexts: Context[] = []
const roots: string[] = []

async function harness(options: HarnessOptions = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'dsh-projcache-'))
  roots.push(root)
  const logs = options.logs ?? new Map<string, SessionEvent[]>()
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.sessionProjections.register(marksUnit(options.stateVersion))
  const persistence = fakePersistence(root, logs)
  ctx.provide('sessionPersistence', persistence as never)
  const fiber = await ctx.plugin(SessionProjectionCache, options.config ?? { writeEveryEvents: 100, writeIntervalMs: 60_000 })
  return { ctx, root, logs, fiber, persistence, cache: ctx.sessionProjectionCache }
}

const mark = (session: Session, marks: string[]): SessionEvent =>
  session.append('cache-test/mark', { marks })

const endTurn = (session: Session): SessionEvent =>
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

/** The stored record for one session id (undefined = absent or unreadable). */
async function storedRecord(root: string, id: Session['id']): Promise<CheckpointRecord | undefined> {
  try {
    return checkpointRecord.parse(JSON.parse(await readFile(cachePath(root, id), 'utf8')))
  } catch {
    return undefined
  }
}

/** The stored rows for one session id (undefined = absent or unreadable). */
async function storedRows(root: string, id: Session['id']): Promise<CheckpointRecord['rows'] | undefined> {
  return (await storedRecord(root, id))?.rows
}

/** Pre-seed one session's cache file with a stored checkpoint record. */
async function seedRecord(
  root: string,
  id: string,
  rows: CheckpointRecord['rows'],
  identity: CheckpointRecord['identity'] = { createdAt: 0 },
): Promise<void> {
  await mkdir(dirname(cachePath(root, SessionId(id))), { recursive: true })
  await writeFile(cachePath(root, SessionId(id)), JSON.stringify({ identity, rows }))
}

/** Wait until queued fail-soft writes (event-listener fire-and-forget over real fs I/O) drain. */
const settle = () => new Promise(resolve => setTimeout(resolve, 40))

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('SessionProjectionCache write policy', () => {
  it('writes a durable checkpoint at turn/end (mandatory point)', async () => {
    const { ctx, root } = await harness()
    const session = ctx.sessions.create(SessionId('turn-end'))
    mark(session, ['a'])
    expect(await storedRows(root, session.id)).toBeUndefined() // throttled: no write yet
    const end = endTurn(session)
    await settle()
    const rows = await storedRows(root, session.id)
    expect(rows?.['cache-test/marks']).toEqual({ ver: 1, seq: end.seq, val: { marks: ['a'] } })
  })

  it('writes at session disposal (detach, the live-to-cold moment)', async () => {
    const { ctx, root } = await harness()
    // Sessions dispose with their owning fiber: create in a child plugin.
    let session: Session | undefined
    const owner = await ctx.plugin(Object.assign((inner: Context) => {
      session = inner.sessions.create(SessionId('detach'))
    }, { inject: ['sessions'] }))
    if (session === undefined) throw new Error('session was not created')
    mark(session, ['live'])
    await owner.dispose()
    await settle()
    expect((await storedRows(root, session.id))?.['cache-test/marks']?.val).toEqual({ marks: ['live'] })
  })

  it('flushes when the in-turn event count reaches the configured threshold', async () => {
    const { ctx, root } = await harness({ config: { writeEveryEvents: 3, writeIntervalMs: 60_000 } })
    const session = ctx.sessions.create(SessionId('count'))
    mark(session, ['1'])
    mark(session, ['2'])
    await settle()
    expect(await storedRows(root, session.id)).toBeUndefined()
    mark(session, ['3'])
    await settle()
    expect((await storedRows(root, session.id))?.['cache-test/marks']?.val).toEqual({ marks: ['3'] })
  })

  it('flushes on the configured interval when the count threshold is not reached', async () => {
    const { ctx, root } = await harness({ config: { writeEveryEvents: 100, writeIntervalMs: 20 } })
    const session = ctx.sessions.create(SessionId('interval'))
    mark(session, ['slow'])
    await new Promise(resolve => setTimeout(resolve, 10)) // before the interval
    expect(await storedRows(root, session.id)).toBeUndefined()
    await settle() // past the interval; the fire-and-forget write lands
    expect((await storedRows(root, session.id))?.['cache-test/marks']?.val).toEqual({ marks: ['slow'] })
  })

  it('write() on a never-dirty session checkpoints directly and rejects a non-JSON unit state', async () => {
    const { ctx, root } = await harness()
    // Never dirtied: no events — write() still lands the init-derived cut.
    const clean = ctx.sessions.create(SessionId('clean-write'))
    await ctx.sessionProjectionCache.write(clean)
    expect((await storedRows(root, clean.id))?.['cache-test/marks']).toEqual({ ver: 1, seq: -1, val: null })
    // A unit whose state violates the plain-JSON contract fails the write loud.
    ctx.sessionProjections.register({
      key: 'cache-test/marks2',
      stateSchema: z.custom<Map<string, string>>(() => true),
      init: () => new Map<string, string>(),
      apply: state => state,
      stateVersion: 1,
    })
    await expect(ctx.sessionProjectionCache.write(clean)).rejects.toThrow('not losslessly JSON-serializable')
  })

  it('plugin disposal clears armed interval timers and leaves cleaned sessions alone', async () => {
    vi.useFakeTimers()
    const { ctx, root, fiber } = await harness({ config: { writeEveryEvents: 100, writeIntervalMs: 5000 } })
    const armed = ctx.sessions.create(SessionId('armed'))
    const cleaned = ctx.sessions.create(SessionId('cleaned'))
    mark(armed, ['pending']) // timer armed, no write yet
    mark(cleaned, ['done'])
    endTurn(cleaned) // mandatory write; markClean leaves {pending: 0, timer: undefined} in the map
    await vi.advanceTimersByTimeAsync(0)
    await fiber.dispose()
    // The armed timer died with the plugin: advancing time writes nothing.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await storedRows(root, armed.id)).toBeUndefined()
  })

  it('contains a durable write failure: logs a warning, event path unharmed, next write self-heals', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-'))
    roots.push(root)
    // A file where a directory is needed makes the first write fail...
    await writeFile(join(root, 'blocked'), '')
    const logs = new Map<string, SessionEvent[]>()
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    ctx.sessionProjections.register(marksUnit())
    let block = true
    ctx.provide('sessionPersistence', {
      readFrom: async (id: SessionId, fromSeq: number) => {
        const events = logs.get(String(id))
        if (events === undefined) throw new Error(`session "${id}" not found`)
        return { meta: { version: 0, id, createdAt: 0 }, events: events.filter(event => event.seq >= fromSeq) }
      },
      // ...and the locate seam can be un-blocked to let the next write succeed.
      locate: (meta: SessionHeader) => block
        ? { kind: 'jsonl', path: join(root, 'blocked', String(meta.id), 'session.jsonl') }
        : { kind: 'jsonl', path: join(root, String(meta.id), 'session.jsonl') },
    } as never)
    await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 100, writeIntervalMs: 60_000 })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const session = ctx.sessions.create(SessionId('fail-soft'))
    mark(session, ['x'])
    endTurn(session)
    await settle()
    expect(await storedRows(root, session.id)).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('turn/end write for "fail-soft" failed'))
    // Self-heal: the next mandatory point writes the current cut.
    block = false
    mark(session, ['y'])
    endTurn(session)
    await settle()
    expect((await storedRows(root, session.id))?.['cache-test/marks']?.val).toEqual({ marks: ['y'] })
  })
})

describe('SessionProjectionCache cold read', () => {
  const storedLog = (marks: string[][]): SessionEvent[] => {
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
    ]
    for (const m of marks) {
      events.push({ type: 'cache-test/mark', seq: events.length, time: events.length, data: { marks: m } })
    }
    events.push({ type: 'turn/end', seq: events.length, time: events.length, data: { turn: 1, reason: { kind: 'completed' } } })
    return events
  }

  it('serves a cold session from the cache row plus a bounded tail read, and writes the refresh back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-'))
    roots.push(root)
    const logs = new Map([['cold', storedLog([['a'], ['a', 'b']])]])
    // A warm-era checkpoint at watermark 1 (only ['a'] folded).
    await seedRecord(root, 'cold', { 'cache-test/marks': { ver: 1, seq: 1, val: { marks: ['a'] } } })
    const { cache, persistence, root: sameRoot } = await harness({ root, logs })
    const id = SessionId('cold')
    const snapshot = await cache.coldSnapshot(headerOf(id))
    expect(snapshot.values['cache-test/marks']).toEqual({ marks: ['a', 'b'] })
    expect(snapshot.asOfSeq).toBe(3)
    // The tail read was bounded by the anchored floor (watermark 1 -> floor 1), not 0.
    expect(persistence.readFrom).toHaveBeenCalledWith(id, 1, undefined)
    // Write-back: the stored row advanced to the served cut.
    expect((await storedRows(sameRoot, id))?.['cache-test/marks'])
      .toEqual({ ver: 1, seq: 3, val: { marks: ['a', 'b'] } })
  })

  it('discards a version-mismatched row and refolds the full log', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-'))
    roots.push(root)
    const logs = new Map([['bumped', storedLog([['a']])]])
    await seedRecord(root, 'bumped', { 'cache-test/marks': { ver: 1, seq: 2, val: { marks: ['stale'] } } })
    const { cache, persistence } = await harness({ root, logs, stateVersion: 2 })
    const snapshot = await cache.coldSnapshot(headerOf(SessionId('bumped')))
    expect(snapshot.values['cache-test/marks']).toEqual({ marks: ['a'] })
    // Mismatch pulls the floor to 0: one full read, no second pass needed.
    expect(persistence.readFrom).toHaveBeenCalledTimes(1)
    expect(persistence.readFrom).toHaveBeenCalledWith(SessionId('bumped'), 0, undefined)
  })

  it('detects a log shrunk below the row watermark and degrades to one full re-read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-'))
    roots.push(root)
    const logs = new Map([['shrunk', storedLog([['a']])]]) // seqs 0..2
    await seedRecord(root, 'shrunk', { 'cache-test/marks': { ver: 1, seq: 9, val: { marks: ['ghost'] } } })
    const { cache, persistence } = await harness({ root, logs })
    const snapshot = await cache.coldSnapshot(headerOf(SessionId('shrunk')))
    expect(snapshot.values['cache-test/marks']).toEqual({ marks: ['a'] })
    expect(snapshot.asOfSeq).toBe(2)
    // Anchored tail read (floor 9) came back empty -> full re-read from 0.
    expect(persistence.readFrom).toHaveBeenNthCalledWith(1, SessionId('shrunk'), 9, undefined)
    expect(persistence.readFrom).toHaveBeenNthCalledWith(2, SessionId('shrunk'), 0, undefined)
  })

  it('discards malformed persisted state and degrades to one full re-read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-'))
    roots.push(root)
    const logs = new Map([['malformed', storedLog([['real']])]])
    await seedRecord(root, 'malformed', { 'cache-test/marks': { ver: 1, seq: 1, val: { marks: 'not-an-array' } } })
    const { cache, persistence } = await harness({ root, logs })

    const snapshot = await cache.coldSnapshot(headerOf(SessionId('malformed')))

    expect(snapshot.values['cache-test/marks']).toEqual({ marks: ['real'] })
    expect(persistence.readFrom).toHaveBeenNthCalledWith(1, SessionId('malformed'), 1, undefined)
    expect(persistence.readFrom).toHaveBeenNthCalledWith(2, SessionId('malformed'), 0, undefined)
  })

  it('write-back failure is contained: the snapshot is still served', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-'))
    roots.push(root)
    const logs = new Map([['soft', storedLog([['a']])]])
    const cacheFile = cachePath(root, SessionId('soft'))
    await seedRecord(root, 'soft', { 'cache-test/marks': { ver: 1, seq: 0, val: { marks: [] } } })
    const { ctx, cache } = await harness({ root, logs })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    // A directory where the cache file must land makes the atomic rename fail;
    // the served snapshot is unaffected.
    await rm(cacheFile)
    await mkdir(cacheFile)
    const snapshot = await cache.coldSnapshot(headerOf(SessionId('soft')))
    expect(snapshot.values['cache-test/marks']).toEqual({ marks: ['a'] })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cold-read write-back for "soft" failed'))
  })

  it('rejects for a session with no persisted log', async () => {
    const { cache } = await harness()
    await expect(cache.coldSnapshot(headerOf(SessionId('absent')))).rejects.toThrow('not found')
  })

  it('discards a record bound to a different log lifecycle and refolds from the actual log', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-'))
    roots.push(root)
    const logs = new Map([['reborn', storedLog([['real']])]]) // stored header stamps createdAt 0
    // A checkpoint from a PRIOR lifecycle of the same id (different createdAt):
    // its rows pass every watermark check, but the identity does not match.
    await seedRecord(root, 'reborn', { 'cache-test/marks': { ver: 1, seq: 2, val: { marks: ['phantom'] } } }, { createdAt: 999 })
    const { cache, root: sameRoot } = await harness({ root, logs })
    const snapshot = await cache.coldSnapshot(headerOf(SessionId('reborn')))
    expect(snapshot.values['cache-test/marks']).toEqual({ marks: ['real'] })
    // The write-back rebinds the record to the actual log's identity.
    expect((await storedRecord(sameRoot, SessionId('reborn')))?.identity).toEqual({ createdAt: 0 })
  })

  it('cachedSnapshot returns undefined when every stored row is version-mismatched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-'))
    roots.push(root)
    await seedRecord(root, 'all-stale', { 'cache-test/marks': { ver: 99, seq: 4, val: { marks: ['old'] } } })
    const { cache } = await harness({ root })
    expect(await cache.cachedSnapshot(headerOf(SessionId('all-stale')))).toBeUndefined()
  })

  it('binds identity on cwd too: a matching cwd serves, a moved session does not', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-'))
    roots.push(root)
    await seedRecord(root, 'homed', { 'cache-test/marks': { ver: 1, seq: 2, val: { marks: ['w'] } } }, { createdAt: 0, cwd: '/work' })
    const { cache } = await harness({ root })
    const id = SessionId('homed')
    expect((await cache.cachedSnapshot(headerOf(id, 0, '/work')))?.values['cache-test/marks']).toEqual({ marks: ['w'] })
    expect(await cache.cachedSnapshot(headerOf(id, 0, '/elsewhere'))).toBeUndefined()
    expect(await cache.cachedSnapshot(headerOf(id, 0))).toBeUndefined()
  })

  it('dates an empty stored log at -1 in the zero-units topology', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-'))
    roots.push(root)
    const logs = new Map([['empty', [] as SessionEvent[]]])
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    ctx.provide('sessionPersistence', fakePersistence(root, logs) as never)
    await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 100, writeIntervalMs: 60_000 })
    await expect(ctx.sessionProjectionCache.coldSnapshot(headerOf(SessionId('empty'))))
      .resolves.toEqual({ asOfSeq: -1, values: {} })
  })

  it('cachedSnapshot serves identity-matching rows with the cut watermark and refuses unrelated ones', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-'))
    roots.push(root)
    await seedRecord(root, 'listed', { 'cache-test/marks': { ver: 1, seq: 4, val: { marks: ['t'] } } })
    const { cache } = await harness({ root })
    const id = SessionId('listed')
    // Matching header: values plus the watermark the client seeds under.
    expect(await cache.cachedSnapshot(headerOf(id))).toEqual({ asOfSeq: 4, values: { 'cache-test/marks': { marks: ['t'] } } })
    // A recreated id (different createdAt): the record is unrelated — no block.
    expect(await cache.cachedSnapshot(headerOf(id, 777))).toBeUndefined()
    // Unknown id: no block.
    expect(await cache.cachedSnapshot(headerOf(SessionId('never-cached')))).toBeUndefined()
  })

  it('holds the not-found contract with zero registered units, and dates the empty cut for a present log', async () => {
    // Same composition minus any registered unit: restoreFloor is undefined,
    // yet coldSnapshot must still reject for an absent log (probe read) and
    // serve an empty cut at the stored end for a present one.
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-'))
    roots.push(root)
    const logs = new Map([['bare', storedLog([['a']])]]) // seqs 0..2
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    ctx.provide('sessionPersistence', fakePersistence(root, logs) as never)
    await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 100, writeIntervalMs: 60_000 })
    await expect(ctx.sessionProjectionCache.coldSnapshot(headerOf(SessionId('absent')))).rejects.toThrow('not found')
    await expect(ctx.sessionProjectionCache.coldSnapshot(headerOf(SessionId('bare'))))
      .resolves.toEqual({ asOfSeq: 2, values: {} })
  })
})
