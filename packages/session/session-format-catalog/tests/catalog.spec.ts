import { describe, expect, it } from 'vitest'
import { sessionFormatCatalog } from '../src/index.ts'

describe('first-party Session format catalog', () => {
  it('statically owns the complete adjacent v0 to v3 chain', () => {
    const header = {
      type: 'session',
      version: 0,
      id: 'catalog',
      createdAt: 1,
      seedLength: 0,
      delegationDepth: 0,
    }

    expect(sessionFormatCatalog.currentVersion).toBe(3)
    expect(sessionFormatCatalog.readHeader(header)).toEqual({
      status: 'migration-required',
      storedVersion: 0,
      targetVersion: 3,
      header: {
        version: 3,
        id: 'catalog',
        createdAt: 1,
        isSeeded: true,
        delegationDepth: 0,
      },
    })

    const v1Header = { ...header, version: 1 }
    const restore = sessionFormatCatalog.createRestore(v1Header, {
      recovery: 'strict', validation: 'current',
    })
    restore.decodeRow({ type: 'turn/start', seq: 0, time: 2, data: { turn: 1 } })
    expect(restore.finish()).toMatchObject({
      header: { version: 3, id: 'catalog' },
    })
  })

  it('restores the installed current vocabulary without freezing ordinary payload additions', () => {
    const header = {
      type: 'session', version: 3, id: 'current-growth', createdAt: 1, isSeeded: false, delegationDepth: 0,
    }
    const restore = (rows: readonly unknown[]) => {
      const current = sessionFormatCatalog.createRestore(header, {
        recovery: 'strict', validation: 'current',
      })
      for (const row of rows) current.decodeRow(row)
      return current.finish()
    }
    const extended = restore([{
      type: 'turn/start', seq: 0, time: 1, data: { turn: 1, postReleaseMember: true },
    }])
    expect(extended.events).toEqual([{
      type: 'turn/start', seq: 0, time: 1, data: { turn: 1, postReleaseMember: true },
    }])

    expect(() => restore([{
      type: 'ordinary/not-installed', seq: 0, time: 1, data: 'future',
    }])).toThrow(/unknown event type/)

    const extension = restore([{
      type: 'ordinary/external', seq: 0, time: 1, data: null, ignorable: true,
    }])
    expect(extension.events).toEqual([{
      type: 'ordinary/external', seq: 0, time: 1, data: null, ignorable: true,
    }])
  })

  it.each([0, 1])('restores v%i empty and non-empty inherited prefixes through every adjacent edge', (version) => {
    for (const seedLength of [0, 1]) {
      const sourceHeader = {
        type: 'session', version, id: 'seed-chain', createdAt: 1,
        parentSession: 'parent', seedLength, delegationDepth: 0,
      }
      const restore = sessionFormatCatalog.createRestore(sourceHeader, { recovery: 'strict', validation: 'current' })
      if (seedLength > 0) {
        restore.decodeRow({ type: 'feedback/record', seq: 0, time: 1, data: { text: 'inherited' } })
      }
      const artifact = restore.finish()
      expect(artifact.header.version).toBe(3)
      expect(artifact.inheritedEventCount).toBe(seedLength)
      expect(artifact.events.at(-1)).toEqual({
        type: 'session/end-seed', seq: seedLength, time: 1, data: { inherited: true },
      })
      expect(sourceHeader.version).toBe(version)
    }
  })

  it.each([false, true])('preserves decoded v2 events and the inherited cut (seeded=%s)', (isSeeded) => {
    const header = { type: 'session', version: 2, id: 'v2-identity', createdAt: 1, isSeeded, delegationDepth: 0 }
    const rows = [
      { type: 'external/event', seq: 0, time: 1, data: { extra: ['unchanged'] }, ignorable: true },
      ...(isSeeded ? [{ type: 'session/end-seed', seq: 1, time: 2, data: { inherited: true } }] : []),
    ]
    const before = JSON.stringify({ header, rows })
    const restore = sessionFormatCatalog.createRestore(header, { recovery: 'strict', validation: 'current' })
    for (const row of rows) restore.decodeRow(row)
    expect(restore.finish()).toEqual({
      header: { version: 3, id: 'v2-identity', createdAt: 1, isSeeded, delegationDepth: 0 },
      inheritedEventCount: isSeeded ? 1 : 0, events: rows,
    })
    expect(JSON.stringify({ header, rows })).toBe(before)
  })

  it.each(['current', 'transformed'] as const)('refuses a v3 delivery marker in v2 input (%s)', (validation) => {
    const header = { type: 'session', version: 2, id: 'future-delivery', createdAt: 1, isSeeded: false, delegationDepth: 0 }
    const restore = sessionFormatCatalog.createRestore(header, { recovery: 'strict', validation })
    restore.decodeRow({ type: 'feedback/record', seq: 0, time: 1, data: { text: 'unaccepted' } })
    expect(() => {
      restore.decodeRow({ type: 'session-log-deepseek/delivery-accepted', seq: 1, time: 2,
        data: { sessionId: header.id, throughSeq: 0, sessionFormatVersion: 3 } })
      restore.finish()
    }).toThrow(/format v2 delivery marker claims target format v3/)
  })

  it('validates complete relationships after streaming migration', () => {
    const stream = sessionFormatCatalog.createRestore({
      type: 'session', version: 1, id: 'invalid-stream', createdAt: 1, delegationDepth: 0,
    }, { recovery: 'strict', validation: 'current' })
    stream.decodeRow({ type: 'step/start', seq: 0, time: 2, data: { turn: 1, step: 1 } })

    expect(() => stream.finish()).toThrow(/open turn/)
  })
})
