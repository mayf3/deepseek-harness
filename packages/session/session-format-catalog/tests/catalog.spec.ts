import { describe, expect, it } from 'vitest'
import { sessionFormatCatalog } from '../src/index.ts'

describe('first-party Session format catalog', () => {
  it('statically owns the complete v0 to v1 chain', () => {
    const header = {
      type: 'session',
      version: 0,
      id: 'catalog',
      createdAt: 1,
      seedLength: 0,
      delegationDepth: 0,
    }

    expect(sessionFormatCatalog.currentVersion).toBe(1)
    expect(sessionFormatCatalog.readHeader(header)).toEqual({
      status: 'migration-required',
      storedVersion: 0,
      targetVersion: 1,
      header: {
        version: 1,
        id: 'catalog',
        createdAt: 1,
        isSeeded: true,
        delegationDepth: 0,
      },
    })

    const currentHeader = { ...header, version: 1 }
    const current = sessionFormatCatalog.decodeArtifact(currentHeader, [
      { type: 'turn/start', seq: 0, time: 2, data: { turn: 1 } },
    ])
    expect(sessionFormatCatalog.migrate(current)).toMatchObject({
      header: { version: 1, id: 'catalog' },
    })
  })

  it('restores the installed current vocabulary without freezing ordinary payload additions', () => {
    const header = {
      type: 'session', version: 1, id: 'current-growth', createdAt: 1, delegationDepth: 0,
    }
    const extended = sessionFormatCatalog.decodeArtifact(header, [{
      type: 'turn/start', seq: 0, time: 1, data: { turn: 1, postReleaseMember: true },
    }])
    expect(sessionFormatCatalog.migrate(extended).events).toEqual(extended.events)

    const unknownRequired = sessionFormatCatalog.decodeArtifact(header, [{
      type: 'ordinary/not-installed', seq: 0, time: 1, data: 'future',
    }])
    expect(() => sessionFormatCatalog.migrate(unknownRequired)).toThrow(/unknown required event/)

    const unknownIgnorable = sessionFormatCatalog.decodeArtifact(header, [{
      type: 'ordinary/external', seq: 0, time: 1, data: null, ignorable: true,
    }])
    expect(sessionFormatCatalog.migrate(unknownIgnorable).events).toEqual(unknownIgnorable.events)
  })
})
