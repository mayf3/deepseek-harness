import { describe, expect, it } from 'vitest'
import { sessionFormatCatalog } from '../src/index.ts'

describe('first-party Session format catalog', () => {
  it('statically owns the complete adjacent v0 to v2 chain', () => {
    const header = {
      type: 'session',
      version: 0,
      id: 'catalog',
      createdAt: 1,
      seedLength: 0,
      delegationDepth: 0,
    }

    expect(sessionFormatCatalog.currentVersion).toBe(2)
    expect(sessionFormatCatalog.readHeader(header)).toEqual({
      status: 'migration-required',
      storedVersion: 0,
      targetVersion: 2,
      header: {
        version: 2,
        id: 'catalog',
        createdAt: 1,
        isSeeded: true,
        delegationDepth: 0,
      },
    })

    const v1Header = { ...header, version: 1 }
    const current = sessionFormatCatalog.decodeArtifact(v1Header, [
      { type: 'turn/start', seq: 0, time: 2, data: { turn: 1 } },
    ])
    expect(sessionFormatCatalog.migrate(current)).toMatchObject({
      header: { version: 2, id: 'catalog' },
    })
  })

  it('restores exact current payloads while retaining explicitly ignorable extensions', () => {
    const header = {
      type: 'session', version: 2, id: 'current-growth', createdAt: 1, isSeeded: false, delegationDepth: 0,
    }
    expect(() => sessionFormatCatalog.decodeArtifact(header, [{
      type: 'turn/start', seq: 0, time: 1, data: { turn: 1, postReleaseMember: true },
    }])).toThrow(/unexpected field postReleaseMember/)

    expect(() => sessionFormatCatalog.decodeArtifact(header, [{
      type: 'ordinary/not-installed', seq: 0, time: 1, data: 'future',
    }])).toThrow(/unknown event type/)

    const extension = sessionFormatCatalog.decodeArtifact(header, [{
      type: 'ordinary/external', seq: 0, time: 1, data: null, ignorable: true,
    }])
    expect(sessionFormatCatalog.migrate(extension).events).toEqual([{
      type: 'ordinary/external', seq: 0, time: 1, data: null, ignorable: true,
    }])
  })
})
