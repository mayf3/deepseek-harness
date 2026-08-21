import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  SessionPersistenceRevision,
  SessionPersistenceRevisionConflictError,
} from '../src/revision.ts'
import type {
  SessionFormatMigration,
  StoredEventReadCompletion,
  StoredSessionSource,
} from '../src/format-decoder.ts'
import { sessionFormatVersionRefusal } from '../src/format-decoder.ts'
import { unversionedFormatCompatibility } from '../src/format-v0-compat.ts'

const id = SessionId('format-migration')
type SessionFormatMigrationInstance = InstanceType<SessionFormatMigration>

function eventLog(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

async function collectEvents(events: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const collected: SessionEvent[] = []
  for await (const event of events) collected.push(event)
  return collected
}

async function decodedFailure(
  decoded: ReturnType<typeof import('../src/format-decoder.ts')['decodeStoredSession']>,
): Promise<Error> {
  const completion = decoded.completed.catch((error: unknown) => error)
  const consumption = collectEvents(decoded.events).catch((error: unknown) => error)
  const [streamFailure, completionFailure] = await Promise.all([consumption, completion])
  expect(streamFailure).toBe(completionFailure)
  expect(streamFailure).toBeInstanceOf(Error)
  return streamFailure as Error
}

function storedSource(
  version: number,
  events: readonly unknown[],
): { source: StoredSessionSource<never>; reads: number[]; meta: Record<string, unknown> } {
  const reads: number[] = []
  const meta: Record<string, unknown> = { version, id, createdAt: 1 }
  return {
    meta,
    reads,
    source: {
      meta,
      revision: SessionPersistenceRevision(`format-v${version}`),
      readEvents({ fromSeq = 0 } = {}) {
        reads.push(fromSeq)
        return {
          events: (async function* (): AsyncIterable<unknown> {
            for (const event of events) {
              const seq = typeof event === 'object' && event !== null
                ? (event as { seq?: unknown }).seq
                : undefined
              if (!Number.isSafeInteger(seq) || (seq as number) < 0 || (seq as number) >= fromSeq) {
                yield structuredClone(event)
              }
            }
          })(),
          completed: Promise.resolve({}),
        }
      },
    },
  }
}

function defineMigration(
  from: number,
  create: () => SessionFormatMigrationInstance,
  to = from + 1,
): SessionFormatMigration {
  return class implements SessionFormatMigrationInstance {
    static readonly from = from
    static readonly to = to

    private readonly delegate = create()

    header(meta: unknown): unknown {
      return this.delegate.header(meta)
    }

    event(value: unknown): unknown {
      return this.delegate.event(value)
    }

    finish(): void {
      this.delegate.finish?.()
    }
  }
}

function migration(
  from: number,
  calls: string[],
  to = from + 1,
): SessionFormatMigration {
  return defineMigration(from, () => {
    let observedInput = false
    return {
      header(meta) {
        calls.push(`header:${from}`)
        return { ...(meta as Record<string, unknown>), version: to }
      },
      event(value) {
        if (!observedInput) {
          calls.push(`events:${from}`)
          observedInput = true
        }
        const event = value as SessionEvent
        const data = event.data as Record<string, unknown>
        const migrationPath = Array.isArray(data['migrationPath'])
          ? data['migrationPath'] as unknown[]
          : []
        return {
          ...event,
          data: {
            ...data,
            [`migratedFrom${from}`]: true,
            migrationPath: [...migrationPath, from],
          },
        }
      },
    }
  }, to)
}

async function configuredDecoder(
  currentVersion: number,
  migrations: readonly SessionFormatMigration[],
  calls: string[] = [],
): Promise<{
  decodeStoredSession: typeof import('../src/format-decoder.ts')['decodeStoredSession']
  decodeStoredSessionHeader: typeof import('../src/format-decoder.ts')['decodeStoredSessionHeader']
  validateHeader: ReturnType<typeof vi.fn>
}> {
  vi.resetModules()
  const validateHeader = vi.fn((sessionId: SessionId, _seed: unknown, meta: unknown) => {
    calls.push('validate-header')
    const record = meta as Record<string, unknown>
    if (record['version'] !== currentVersion) {
      throw new Error(`current header validator received v${String(record['version'])}`)
    }
    if (record['id'] !== sessionId) throw new Error('current header validator received the wrong id')
    if (!Number.isSafeInteger(record['createdAt'])) {
      throw new Error('current header validator received invalid createdAt')
    }
    return { header: Object.freeze(structuredClone(record)) }
  })
  vi.doMock('@deepseek-ai/dsh-session', async () => {
    const actual = await vi.importActual<typeof import('@deepseek-ai/dsh-session')>(
      '@deepseek-ai/dsh-session',
    )
    return {
      ...actual,
      SESSION_FORMAT_VERSION: currentVersion,
      Session: { create: validateHeader },
    }
  })
  vi.doMock('../src/format-migrations/index.ts', () => ({
    SESSION_FORMAT_MIGRATIONS: migrations,
  }))
  const decoder = await import('../src/format-decoder.ts')
  return {
    decodeStoredSession: decoder.decodeStoredSession,
    decodeStoredSessionHeader: decoder.decodeStoredSessionHeader,
    validateHeader,
  }
}

afterEach(() => {
  vi.doUnmock('@deepseek-ai/dsh-session')
  vi.doUnmock('../src/format-migrations/index.ts')
  vi.resetModules()
})

describe('versioned Session format decoder', { concurrent: false }, () => {
  it('describes both unsupported format directions', () => {
    expect(sessionFormatVersionRefusal(id, 1)).toContain('newer harness')
    expect(sessionFormatVersionRefusal(id, -1)).toContain('older than the supported')
  })

  it('runs a single migration lazily and reads the complete old log before slicing', async () => {
    const calls: string[] = []
    const step = migration(0, calls)
    const { decodeStoredSession, validateHeader } = await configuredDecoder(1, [step], calls)
    const originalEvents = eventLog()
    const originalSnapshot = structuredClone(originalEvents)
    const stored = storedSource(0, originalEvents)

    const decoded = decodeStoredSession(stored.source, id, 1)
    expect(decoded.sourceVersion).toBe(0)
    expect(decoded.meta.version).toBe(1)
    expect(calls).toEqual(['header:0', 'validate-header'])
    expect(stored.reads).toEqual([])

    const migrated = await collectEvents(decoded.events)
    await decoded.completed

    expect(stored.reads).toEqual([0])
    expect(calls).toEqual(['header:0', 'validate-header', 'events:0'])
    expect(migrated).toEqual([
      {
        ...originalEvents[1],
        data: { ...originalEvents[1]?.data, migratedFrom0: true, migrationPath: [0] },
      },
    ])
    expect(originalEvents).toEqual(originalSnapshot)
    expect(stored.meta).toEqual({ version: 0, id, createdAt: 1 })
    expect(validateHeader).toHaveBeenCalledOnce()
  })

  it('lets an old-format suffix migration use facts from events before fromSeq', async () => {
    const step = defineMigration(0, () => {
      let previousSeq: number | undefined
      return {
        header: meta => ({ ...(meta as Record<string, unknown>), version: 1 }),
        event(value) {
          const event = value as SessionEvent
          const migrated = previousSeq === undefined
            ? event
            : { ...event, data: { ...event.data, previousSeq } }
          previousSeq = event.seq
          return migrated
        },
      }
    })
    const { decodeStoredSession } = await configuredDecoder(1, [step])
    const stored = storedSource(0, eventLog())

    const decoded = decodeStoredSession(stored.source, id, 1)
    const events = await collectEvents(decoded.events)
    await decoded.completed

    expect(stored.reads).toEqual([0])
    expect(events).toEqual([{
      ...eventLog()[1],
      data: { ...eventLog()[1]?.data, previousSeq: 0 },
    }])
  })

  it('streams migrated events with backpressure instead of buffering the complete log', async () => {
    const releaseTail = Promise.withResolvers<undefined>()
    const physicalCompletion = Promise.withResolvers<StoredEventReadCompletion<never>>()
    const reads: number[] = []
    const source: StoredSessionSource<never> = {
      meta: { version: 0, id, createdAt: 1 },
      revision: SessionPersistenceRevision('streaming-source'),
      readEvents({ fromSeq = 0 } = {}) {
        reads.push(fromSeq)
        return {
          events: (async function* (): AsyncIterable<unknown> {
            try {
              yield structuredClone(eventLog()[0])
              await releaseTail.promise
              yield structuredClone(eventLog()[1])
              physicalCompletion.resolve({})
            } catch (error: unknown) {
              physicalCompletion.reject(error)
              throw error
            }
          })(),
          completed: physicalCompletion.promise,
        }
      },
    }
    const { decodeStoredSession } = await configuredDecoder(1, [migration(0, [])])
    const decoded = decodeStoredSession(source, id)
    const iterator = decoded.events[Symbol.asyncIterator]()

    const first = await iterator.next()
    expect(first).toMatchObject({ done: false, value: { seq: 0 } })
    expect(reads).toEqual([0])
    let completed = false
    void decoded.completed.then(() => { completed = true })
    await Promise.resolve()
    expect(completed).toBe(false)

    releaseTail.resolve(undefined)
    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { seq: 1 } })
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
    await expect(decoded.completed).resolves.toEqual({})
  })

  it('runs a complete multi-step chain before current header and event validation', async () => {
    const calls: string[] = []
    const { decodeStoredSession } = await configuredDecoder(
      2,
      [migration(0, calls), migration(1, calls)],
      calls,
    )
    const stored = storedSource(0, eventLog())

    const decoded = decodeStoredSession(stored.source, id)
    expect(decoded.meta.version).toBe(2)
    expect(calls).toEqual(['header:0', 'header:1', 'validate-header'])

    const events = await collectEvents(decoded.events)
    await decoded.completed

    expect(calls).toEqual([
      'header:0',
      'header:1',
      'validate-header',
      'events:0',
      'events:1',
    ])
    expect(events[0]?.data).toMatchObject({ migratedFrom0: true, migratedFrom1: true })
    expect(events[0]?.data).toMatchObject({ migrationPath: [0, 1] })
  })

  it('plans by version even when registry entries are declared out of order', async () => {
    const calls: string[] = []
    const { decodeStoredSession } = await configuredDecoder(
      2,
      [migration(1, calls), migration(0, calls)],
      calls,
    )

    const decoded = decodeStoredSession(storedSource(0, eventLog()).source, id)
    const events = await collectEvents(decoded.events)
    await decoded.completed

    expect(calls.slice(0, 3)).toEqual(['header:0', 'header:1', 'validate-header'])
    expect(events[0]?.data).toMatchObject({ migrationPath: [0, 1] })
  })

  it('starts a multi-version registry at the source version', async () => {
    const calls: string[] = []
    const { decodeStoredSession } = await configuredDecoder(
      2,
      [migration(0, calls), migration(1, calls)],
      calls,
    )
    const stored = storedSource(1, eventLog())

    const decoded = decodeStoredSession(stored.source, id, 1)
    const events = await collectEvents(decoded.events)
    await decoded.completed

    expect(calls).toEqual(['header:1', 'validate-header', 'events:1'])
    expect(stored.reads).toEqual([0])
    expect(events[0]?.data).toMatchObject({ migrationPath: [1] })
  })

  it('retains instance state from the header through events and finishes at EOF', async () => {
    const calls: string[] = []
    const Migration = defineMigration(0, () => {
      let headerId: SessionId | undefined
      let migratedEvents = 0
      return {
        header(meta) {
          calls.push('header')
          headerId = SessionId((meta as Record<string, unknown>)['id'] as string)
          return { ...(meta as Record<string, unknown>), version: 1 }
        },
        event(value) {
          calls.push(`event:${migratedEvents}`)
          migratedEvents += 1
          return {
            ...(value as SessionEvent),
            data: { ...(value as SessionEvent).data, headerId, migratedEvents },
          }
        },
        finish() {
          calls.push(`finish:${migratedEvents}`)
        },
      }
    })
    const { decodeStoredSession } = await configuredDecoder(1, [Migration])

    const decoded = decodeStoredSession(storedSource(0, eventLog()).source, id)
    expect(calls).toEqual(['header'])
    const events = await collectEvents(decoded.events)
    await decoded.completed

    expect(calls).toEqual(['header', 'event:0', 'event:1', 'finish:2'])
    expect(events.map(event => event.data)).toMatchObject([
      { headerId: id, migratedEvents: 1 },
      { headerId: id, migratedEvents: 2 },
    ])
  })

  it('migrates and validates a header without requiring an event source', async () => {
    const calls: string[] = []
    const first = defineMigration(0, () => ({
      header(meta) {
        calls.push('header:0')
        return { ...(meta as Record<string, unknown>), version: 1 }
      },
      event: value => value,
      finish() {
        calls.push('finish:0')
      },
    }))
    const { decodeStoredSessionHeader } = await configuredDecoder(
      2,
      [first, migration(1, calls)],
      calls,
    )

    const header = decodeStoredSessionHeader({ version: 0, id, createdAt: 1 }, id)

    expect(header.version).toBe(2)
    expect(calls).toEqual(['header:0', 'header:1', 'validate-header'])
  })

  it('allows a migration instance without finish', async () => {
    class MigrationWithoutFinish implements SessionFormatMigrationInstance {
      static readonly from = 0
      static readonly to = 1

      header(meta: unknown): unknown {
        return { ...(meta as Record<string, unknown>), version: 1 }
      }

      event(value: unknown): unknown {
        return value
      }
    }
    const { decodeStoredSession } = await configuredDecoder(1, [MigrationWithoutFinish])

    const decoded = decodeStoredSession(storedSource(0, eventLog()).source, id)

    await expect(collectEvents(decoded.events)).resolves.toEqual(eventLog())
    await expect(decoded.completed).resolves.toEqual({})
  })

  it('applies event migration before the current event vocabulary check', async () => {
    const step = defineMigration(0, () => ({
      header: meta => ({ ...(meta as Record<string, unknown>), version: 1 }),
      event(value) {
        const event = value as Record<string, unknown>
        return { ...event, type: 'turn/start', data: { turn: 1 } }
      },
    }))
    const { decodeStoredSession } = await configuredDecoder(1, [step])
    const stored = storedSource(0, [
      { type: 'legacy/turn-begin', seq: 0, time: 1, data: { legacyTurn: 1 } },
    ])

    const decoded = decodeStoredSession(stored.source, id)
    const events = await collectEvents(decoded.events)
    await decoded.completed

    expect(events).toEqual([
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    ])
  })

  it('uses suffix access directly for the current format', async () => {
    const { decodeStoredSession } = await configuredDecoder(2, [])
    const stored = storedSource(2, eventLog())

    const decoded = decodeStoredSession(stored.source, id, 1)
    const events = await collectEvents(decoded.events)
    await decoded.completed

    expect(stored.reads).toEqual([1])
    expect(events).toEqual(eventLog().slice(1))
  })

  it('buffers a safe current-v0 suffix once without reopening the prefix', async () => {
    const { decodeStoredSession } = await configuredDecoder(0, [])
    const stored = storedSource(0, eventLog())

    const decoded = decodeStoredSession(stored.source, id, 1)
    expect(await collectEvents(decoded.events)).toEqual(eventLog().slice(1))
    await expect(decoded.completed).resolves.toEqual({})

    expect(stored.reads).toEqual([1])
  })

  it('reopens the complete current-v0 log when a legacy suffix record needs its prefix', async () => {
    const { decodeStoredSession } = await configuredDecoder(0, [])
    const legacy = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      {
        type: 'steering/message',
        seq: 1,
        time: 2,
        data: { turn: 1, content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } },
      },
    ]
    const stored = storedSource(0, legacy)

    const decoded = decodeStoredSession(stored.source, id, 1)
    const events = await collectEvents(decoded.events)
    await decoded.completed

    expect(stored.reads).toEqual([1, 0])
    expect(events).toMatchObject([{ type: 'user/message', seq: 1 }])
  })

  it('observes a failed physical completion after reopening a required v0 prefix', async () => {
    const failure = new SessionPersistenceRevisionConflictError('reopened prefix changed')
    const fullCompletion = Promise.withResolvers<StoredEventReadCompletion<never>>()
    const source: StoredSessionSource<never> = {
      meta: { version: 0, id, createdAt: 1 },
      revision: SessionPersistenceRevision('prefix-conflict'),
      readEvents({ fromSeq = 0 } = {}) {
        if (fromSeq > 0) {
          return {
            events: (async function* (): AsyncIterable<unknown> {
              yield {
                type: 'steering/message', seq: 1, time: 2,
                data: { turn: 1, content: [], source: { kind: 'user' } },
              }
            })(),
            completed: Promise.resolve({}),
          }
        }
        return {
          events: (async function* (): AsyncIterable<unknown> {
            fullCompletion.reject(failure)
            throw failure
          })(),
          completed: fullCompletion.promise,
        }
      },
    }
    const { decodeStoredSession } = await configuredDecoder(0, [])
    const decoded = decodeStoredSession(source, id, 1)

    await expect(decodedFailure(decoded)).resolves.toBe(failure)
  })

  it('classifies every v0 prefix-independent suffix value without assuming a record', () => {
    const compatibility = unversionedFormatCompatibility(0)
    if (compatibility === undefined) throw new Error('v0 compatibility must be registered')

    expect(compatibility.requiresPrefix(null)).toBe(false)
    expect(compatibility.requiresPrefix({ type: 'turn/end', data: null })).toBe(false)
    expect(compatibility.requiresPrefix({ type: 'user/message', data: { id: 'current', content: [] } })).toBe(false)
    expect(compatibility.requiresPrefix({ type: 'user/message', data: { content: [] } })).toBe(true)
    expect(compatibility.requiresPrefix({ type: 'assistant/message', data: { content: [] } })).toBe(true)
    expect(compatibility.requiresPrefix({ type: 'tool/result', data: { callId: 'call' } })).toBe(true)
  })

  it('preserves already-canonical v0 turn-end reasons', async () => {
    const compatibility = unversionedFormatCompatibility(0)
    if (compatibility === undefined) throw new Error('v0 compatibility must be registered')
    const events = [
      {
        type: 'turn/end', seq: 0, time: 1,
        data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } },
      },
      {
        type: 'turn/end', seq: 1, time: 2,
        data: { turn: 2, reason: { kind: 'error', error: { message: 'failed', code: 'UNKNOWN' } } },
      },
    ]
    const input = (async function* (): AsyncIterable<unknown> {
      yield* events
    })()
    const canonical: unknown[] = []

    for await (const event of compatibility.canonicalizeEvents(input, id)) canonical.push(event)

    expect(canonical).toEqual(events)
  })

  it('canonicalizes every historical compact event name without changing its record', async () => {
    const { decodeStoredSession } = await configuredDecoder(0, [])
    const events = [
      {
        type: 'compact/start', seq: 0, time: 1,
        data: { compactionId: 'legacy', turn: 1 },
        surfaceOp: { op: 'retain' },
      },
      {
        type: 'compact/summary', seq: 1, time: 2,
        data: { summary: 'old summary', shadowedSeqs: [7, 8] },
        durableMetadata: { source: 'historical-v0' },
      },
      {
        type: 'compaction/end', seq: 2, time: 3,
        data: { compactionId: 'current', turn: 1 },
      },
      {
        type: 'compact/end', seq: 3, time: 4,
        data: { compactionId: 'legacy', turn: 1 },
      },
      {
        type: 'compact/prune', seq: 4, time: 5,
        data: {
          shadowedRange: { start: 7, end: 8 },
          shadowedSeqs: [7, 8],
          shadowedTokenCount: 456,
        },
      },
    ]
    const stored = storedSource(0, events)

    const decoded = decodeStoredSession(stored.source, id)
    const canonical = await collectEvents(decoded.events)
    await decoded.completed

    expect(canonical).toEqual(events.map(event => ({
      ...event,
      type: event.type.replace(/^compact\//, 'compaction/'),
    })))
    expect(stored.reads).toEqual([0])
  })

  it('still rejects other unknown v0 event names after compaction normalization', async () => {
    const { decodeStoredSession } = await configuredDecoder(0, [])
    const decoded = decodeStoredSession(storedSource(0, [{
      type: 'compact/future', seq: 0, time: 1, data: {},
    }]).source, id)

    const failure = await decodedFailure(decoded)
    expect(failure.message).toMatch(/event type "compact\/future".*not marked ignorable/)
  })

  it('does not run older registered steps for an already-current source', async () => {
    const calls: string[] = []
    const { decodeStoredSession } = await configuredDecoder(
      2,
      [migration(0, calls), migration(1, calls)],
      calls,
    )
    const stored = storedSource(2, eventLog())

    const decoded = decodeStoredSession(stored.source, id, 1)
    await collectEvents(decoded.events)
    await decoded.completed

    expect(calls).toEqual(['validate-header'])
    expect(stored.reads).toEqual([1])
  })

  it('opens a fresh revision-bound reader for each decode of the same source', async () => {
    const { decodeStoredSession } = await configuredDecoder(0, [])
    const stored = storedSource(0, eventLog())

    const first = decodeStoredSession(stored.source, id)
    expect(await collectEvents(first.events)).toEqual(eventLog())
    await first.completed
    const second = decodeStoredSession(stored.source, id)
    expect(await collectEvents(second.events)).toEqual(eventLog())
    await second.completed

    expect(first.revision).toBe(second.revision)
    expect(stored.reads).toEqual([0, 0])
  })

  it('propagates a physical revision conflict unchanged through events and completion', async () => {
    const failure = new SessionPersistenceRevisionConflictError('source changed')
    const physicalCompletion = Promise.withResolvers<StoredEventReadCompletion<never>>()
    const source: StoredSessionSource<never> = {
      meta: { version: 0, id, createdAt: 1 },
      revision: SessionPersistenceRevision('conflicting-source'),
      readEvents: () => ({
        events: (async function* (): AsyncIterable<unknown> {
          physicalCompletion.reject(failure)
          throw failure
        })(),
        completed: physicalCompletion.promise,
      }),
    }
    const { decodeStoredSession } = await configuredDecoder(0, [])
    const decoded = decodeStoredSession(source, id)
    const completion = decoded.completed.catch((error: unknown) => error)
    const consumption = collectEvents(decoded.events).catch((error: unknown) => error)

    const [streamFailure, completionFailure] = await Promise.all([consumption, completion])
    expect(streamFailure).toBe(failure)
    expect(completionFailure).toBe(failure)
  })

  it('propagates an upstream revision conflict unchanged through a migration step', async () => {
    const { decodeStoredSession } = await configuredDecoder(1, [migration(0, [])])
    const { SessionPersistenceRevisionConflictError: DecoderRevisionConflictError } = await import('../src/revision.ts')
    const failure = new DecoderRevisionConflictError('migrating source changed')
    const source: StoredSessionSource<never> = {
      meta: { version: 0, id, createdAt: 1 },
      revision: SessionPersistenceRevision('conflicting-migration-source'),
      readEvents: () => ({
        events: (async function* (): AsyncIterable<unknown> {
          throw failure
        })(),
        completed: Promise.reject(failure),
      }),
    }
    await expect(decodedFailure(decodeStoredSession(source, id))).resolves.toBe(failure)
  })

  it('rejects a missing path and a future source in the correct direction', async () => {
    const { decodeStoredSession, validateHeader } = await configuredDecoder(2, [])
    const old = storedSource(0, [])
    const future = storedSource(3, [])

    expect(() => decodeStoredSession(old.source, id))
      .toThrow(/missing v0 -> v1/)
    expect(() => decodeStoredSession(future.source, id))
      .toThrow(/newer harness/)
    expect(old.reads).toEqual([])
    expect(future.reads).toEqual([])
    expect(validateHeader).not.toHaveBeenCalled()
  })

  it('preserves the raw location in unsupported-format diagnostics', async () => {
    const { decodeStoredSession } = await configuredDecoder(0, [])
    const stored = storedSource(1, [])
    const location = { kind: 'jsonl', path: '/tmp/session.jsonl' }
    const source: StoredSessionSource<never> = { ...stored.source, location }

    let failure: unknown
    try {
      decodeStoredSession(source, id)
    } catch (error: unknown) {
      failure = error
    }
    expect(failure).toMatchObject({
      name: 'SessionFormatUnsupportedError',
      location,
    })
    expect((failure as Error).message).toContain('(raw log: /tmp/session.jsonl)')
  })

  it('rejects an invalid suffix before validating the header or opening events', async () => {
    const { decodeStoredSession, validateHeader } = await configuredDecoder(0, [])
    const stored = storedSource(0, eventLog())

    for (const fromSeq of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => decodeStoredSession(stored.source, id, fromSeq))
        .toThrow(/fromSeq must be a non-negative safe integer/)
    }
    expect(validateHeader).not.toHaveBeenCalled()
    expect(stored.reads).toEqual([])
  })

  it('validates unknown durable header fields before path selection', async () => {
    const { decodeStoredSession, validateHeader } = await configuredDecoder(0, [])
    const cases: Array<{ meta: unknown; message: RegExp }> = [
      { meta: null, message: /header is not a lossless JSON record/ },
      { meta: { version: '0', id }, message: /invalid format version/ },
      { meta: { version: 0, id: 42 }, message: /has no string id/ },
    ]
    let reads = 0

    for (const entry of cases) {
      const source: StoredSessionSource<never> = {
        meta: entry.meta,
        revision: SessionPersistenceRevision('invalid-header'),
        readEvents: () => {
          reads += 1
          return { events: (async function* () {})(), completed: Promise.resolve({}) }
        },
      }
      expect(() => decodeStoredSession(source, id)).toThrow(entry.message)
    }
    expect(reads).toBe(0)
    expect(validateHeader).not.toHaveBeenCalled()
  })

  it('rejects every malformed current event envelope through the stream and completion', async () => {
    const { decodeStoredSession } = await configuredDecoder(1, [])
    const cases: Array<{ value: unknown; message: RegExp }> = [
      { value: null, message: /non-record event/ },
      { value: { seq: 0, time: 1, data: {} }, message: /without a string type/ },
      { value: { type: 'turn/start', seq: -1, time: 1, data: {} }, message: /invalid seq -1/ },
      { value: { type: 'turn/start', seq: 0, time: 'now', data: {} }, message: /invalid time/ },
      { value: { type: 'turn/start', seq: 0, time: 1 }, message: /without data/ },
    ]

    for (const entry of cases) {
      const decoded = decodeStoredSession(storedSource(1, [entry.value]).source, id)
      expect((await decodedFailure(decoded)).message).toMatch(entry.message)
    }
  })

  it('rejects a stored event that cannot be represented as JSON', async () => {
    const { decodeStoredSession } = await configuredDecoder(1, [])
    const decoded = decodeStoredSession(storedSource(1, [undefined]).source, id)

    expect((await decodedFailure(decoded)).message).toMatch(/not losslessly JSON-serializable/)
  })

  it('rejects every malformed v0 event before same-version canonicalization', async () => {
    const { decodeStoredSession } = await configuredDecoder(0, [])
    const cases: Array<{ value: unknown; message: RegExp }> = [
      { value: null, message: /non-record event/ },
      { value: { seq: 0, time: 1, data: {} }, message: /without a string type/ },
      { value: { type: 'turn/start', seq: -1, time: 1, data: {} }, message: /invalid seq -1/ },
      { value: { type: 'turn/start', seq: 0, time: 'now', data: {} }, message: /invalid time/ },
      { value: { type: 'turn/start', seq: 0, time: 1 }, message: /without data/ },
    ]

    for (const entry of cases) {
      const decoded = decodeStoredSession(storedSource(0, [entry.value]).source, id)
      expect((await decodedFailure(decoded)).message).toMatch(entry.message)
    }
  })

  it('lets a v0 turn/end with opaque data reach current validation unchanged', async () => {
    const { decodeStoredSession } = await configuredDecoder(0, [])
    const decoded = decodeStoredSession(storedSource(0, [
      { type: 'turn/end', seq: 0, time: 1, data: null },
    ]).source, id)

    await expect(collectEvents(decoded.events)).resolves.toEqual([
      { type: 'turn/end', seq: 0, time: 1, data: null },
    ])
    await expect(decoded.completed).resolves.toEqual({})
  })

  it('rejects a migration that returns the wrong header version', async () => {
    const bad = defineMigration(0, () => ({
      header: meta => ({ ...(meta as Record<string, unknown>), version: 0 }),
      event: value => value,
    }))
    const first = await configuredDecoder(1, [bad])

    expect(() => first.decodeStoredSession(storedSource(0, []).source, id))
      .toThrow(/returned header version 0/)
    expect(first.validateHeader).not.toHaveBeenCalled()

    const calls: string[] = []
    const badSecond = defineMigration(1, () => ({
      header: meta => ({ ...(meta as Record<string, unknown>), version: 1 }),
      event: value => value,
    }))
    const second = await configuredDecoder(2, [migration(0, calls), badSecond], calls)
    const stored = storedSource(0, [])
    expect(() => second.decodeStoredSession(stored.source, id))
      .toThrow(/v1 -> v2 returned header version 1/)
    expect(calls).toEqual(['header:0'])
    expect(second.validateHeader).not.toHaveBeenCalled()
    expect(stored.reads).toEqual([])
  })

  it('rejects a migration that changes the session id or cwd storage identity', async () => {
    const changedId = defineMigration(0, () => ({
      header: meta => ({ ...(meta as Record<string, unknown>), version: 1, id: 'other' }),
      event: value => value,
    }))
    const first = await configuredDecoder(1, [changedId])
    expect(() => first.decodeStoredSession(storedSource(0, []).source, id))
      .toThrow(/changed session storage identity/)

    const changedCwd = defineMigration(0, () => ({
      header: meta => ({ ...(meta as Record<string, unknown>), version: 1, cwd: '/other' }),
      event: value => value,
    }))
    const second = await configuredDecoder(1, [changedCwd])
    const stored = storedSource(0, [])
    stored.meta['cwd'] = '/work'
    expect(() => second.decodeStoredSession(stored.source, id))
      .toThrow(/changed session storage identity/)
  })

  it('wraps a header migration failure with the failing version step', async () => {
    const cause = new Error('bad legacy header')
    const step = defineMigration(0, () => ({
      header: () => { throw cause },
      event: value => value,
    }))
    const { decodeStoredSession } = await configuredDecoder(1, [step])

    let failure: unknown
    try {
      decodeStoredSession(storedSource(0, []).source, id)
    } catch (error: unknown) {
      failure = error
    }
    expect(failure).toMatchObject({
      message: `session "${id}" header migration v0 -> v1 failed`,
      cause,
    })
  })

  it('mirrors an event migration failure through the stream and completion promise', async () => {
    const cause = new Error('bad legacy event')
    const step = defineMigration(0, () => ({
      header: meta => ({ ...(meta as Record<string, unknown>), version: 1 }),
      event: () => { throw cause },
    }))
    const { decodeStoredSession } = await configuredDecoder(1, [step])
    const decoded = decodeStoredSession(storedSource(0, eventLog()).source, id)
    const completion = decoded.completed.catch((error: unknown) => error)
    const consumption = collectEvents(decoded.events).catch((error: unknown) => error)

    const [streamFailure, completionFailure] = await Promise.all([consumption, completion])
    expect(streamFailure).toBe(completionFailure)
    expect(streamFailure).toMatchObject({
      message: `session "${id}" event migration v0 -> v1 failed at seq 0`,
      cause,
    })
  })

  it('mirrors a finish failure through the stream and completion promise', async () => {
    const cause = new Error('unclosed legacy state')
    const Migration = defineMigration(0, () => ({
      header: meta => ({ ...(meta as Record<string, unknown>), version: 1 }),
      event: value => value,
      finish: () => { throw cause },
    }))
    const { decodeStoredSession } = await configuredDecoder(1, [Migration])

    const failure = await decodedFailure(decodeStoredSession(storedSource(0, eventLog()).source, id))
    expect(failure).toMatchObject({
      message: `session "${id}" event migration v0 -> v1 failed at EOF`,
      cause,
    })
  })

  it('rejects a migration that changes an event sequence number', async () => {
    const step = defineMigration(0, () => ({
      header: meta => ({ ...(meta as Record<string, unknown>), version: 1 }),
      event(value) {
        const event = value as SessionEvent
        return { ...event, seq: event.seq + 1 }
      },
    }))
    const { decodeStoredSession } = await configuredDecoder(1, [step])
    const decoded = decodeStoredSession(storedSource(0, eventLog()).source, id)
    const completion = decoded.completed.catch((error: unknown) => error)
    const consumption = collectEvents(decoded.events).catch((error: unknown) => error)

    const [streamFailure, completionFailure] = await Promise.all([consumption, completion])
    expect(streamFailure).toBe(completionFailure)
    expect((streamFailure as Error).message).toMatch(/changed event seq 0 to 1/)
  })

  it('rejects a non-contiguous current-format event sequence', async () => {
    const { decodeStoredSession } = await configuredDecoder(0, [])
    const stored = storedSource(0, [
      { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    ])

    const failure = await decodedFailure(decodeStoredSession(stored.source, id))

    expect(failure.message).toContain(`session "${id}" event seq mismatch: expected 0, got 1`)
  })

  it('runs current header validation only after the final header step', async () => {
    const calls: string[] = []
    const finalStep = defineMigration(1, () => ({
      header(meta) {
        calls.push('header:1')
        const { createdAt: _createdAt, ...rest } = meta as Record<string, unknown>
        return { ...rest, version: 2 }
      },
      event: value => value,
    }))
    const { decodeStoredSession } = await configuredDecoder(
      2,
      [migration(0, calls), finalStep],
      calls,
    )
    const stored = storedSource(0, eventLog())

    expect(() => decodeStoredSession(stored.source, id))
      .toThrow(/current header validator received invalid createdAt/)
    expect(calls).toEqual(['header:0', 'header:1', 'validate-header'])
    expect(stored.reads).toEqual([])
  })

  it('detaches stored header and event objects before a mutating migration runs', async () => {
    const originalEvents = eventLog()
    const eventSnapshot = structuredClone(originalEvents)
    const step = defineMigration(0, () => ({
      header(meta) {
        const record = meta as Record<string, unknown>
        record['version'] = 1
        return record
      },
      event(value) {
        const event = value as SessionEvent
        const data = event.data as Record<string, unknown>
        data['mutated'] = true
        return event
      },
    }))
    const { decodeStoredSession } = await configuredDecoder(1, [step])
    const stored = storedSource(0, originalEvents)

    const decoded = decodeStoredSession(stored.source, id)
    const migrated = await collectEvents(decoded.events)
    await decoded.completed

    expect(migrated.every(event => (event.data as Record<string, unknown>)['mutated'] === true)).toBe(true)
    expect(stored.meta).toEqual({ version: 0, id, createdAt: 1 })
    expect(originalEvents).toEqual(eventSnapshot)
  })

  it('rejects duplicate, invalid, and future-targeting static registries at initialization', async () => {
    const calls: string[] = []
    await expect(configuredDecoder(1, [migration(0, calls), migration(0, calls)]))
      .rejects.toThrow(/duplicate Session format migration/)

    await expect(configuredDecoder(1, [migration(-1, calls)]))
      .rejects.toThrow(/adjacent non-negative version/)

    const nonAdjacent = migration(0, calls, 2)
    await expect(configuredDecoder(2, [nonAdjacent]))
      .rejects.toThrow(/adjacent non-negative version/)

    const fractional = migration(0.5, calls, 1.5)
    await expect(configuredDecoder(2, [fractional]))
      .rejects.toThrow(/adjacent non-negative version/)

    await expect(configuredDecoder(1, [migration(1, calls)]))
      .rejects.toThrow(/targets a version newer than this build/)
  })

  it('initializes with a gapped registry and refuses only sessions at or below the gap', async () => {
    const calls: string[] = []
    const { decodeStoredSession } = await configuredDecoder(
      3,
      [migration(0, calls), migration(2, calls)],
      calls,
    )
    const current = storedSource(3, [])
    const pastGap = storedSource(2, eventLog())
    const atGap = storedSource(1, eventLog())
    const belowGap = storedSource(0, eventLog())

    expect(decodeStoredSession(current.source, id).meta.version).toBe(3)
    const decoded = decodeStoredSession(pastGap.source, id)
    expect(decoded.sourceVersion).toBe(2)
    expect(decoded.meta.version).toBe(3)
    expect(() => decodeStoredSession(atGap.source, id))
      .toThrow(/missing v1 -> v2/)
    expect(() => decodeStoredSession(belowGap.source, id))
      .toThrow(/missing v1 -> v2/)
    expect(pastGap.reads).toEqual([])
  })
})
