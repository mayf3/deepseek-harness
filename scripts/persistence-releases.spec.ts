/** Offline release archives preserve historical schemas and reject incomplete or inconsistent transitions. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dump } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { parsePersistenceSnapshot } from './persistence-changes.ts'
import { canonicalizeSchema, schemaDigest } from './persistence-schema-model.ts'
import type { PersistenceRoot, PersistenceSchemaInventory, PersistenceType, SchemaNode } from './persistence-schema-model.ts'
import { loadPersistenceReleases } from './persistence-releases.ts'
import type { PersistenceReleaseManifest, PersistenceReleaseRecord } from './persistence-releases.ts'

const TAGS = ['dsh-v0.1.0-alpha.1', 'dsh-v0.1.0-rc.1', 'dsh-v0.1.0-rc.2'] as const
const temporary: string[] = []
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }) })

function rootSchema(key: string, nodes: readonly SchemaNode[], surface = false): PersistenceRoot {
  const schema = canonicalizeSchema(nodes, 0)
  return {
    key, kind: key.startsWith('event:') ? 'event' : key === 'SessionEventEnvelope' ? 'envelope' : 'header',
    ...(key.startsWith('event:') ? { event: key.slice(6), surface } : {}), schema, digest: schemaDigest(schema),
  }
}

function event(value: 'number' | 'string'): PersistenceRoot {
  return rootSchema('event:example/value', [
    { kind: 'object', indices: [], properties: [
      { name: 'type', type: 1, optional: false },
      { name: 'data', type: 2, optional: false },
      { name: 'surfaceOp', type: 3, optional: true },
    ] },
    { kind: 'literal', value: 'example/value' },
    { kind: 'primitive', type: value },
    { kind: 'primitive', type: 'string' },
  ], true)
}

function inventory(roots: readonly PersistenceRoot[]): PersistenceSchemaInventory {
  const types = new Map<string, PersistenceType>()
  for (const root of roots) {
    for (const [index] of root.schema.nodes.entries()) {
      const schema = canonicalizeSchema(root.schema.nodes, index)
      const digest = schemaDigest(schema)
      types.set(digest, { digest, schema, names: [], sources: [] })
    }
  }
  return { formatVersion: 1, roots, types: [...types.values()] }
}

interface Fixture {
  readonly root: string
  readonly directory: string
  readonly manifest: PersistenceReleaseManifest
  readonly records: readonly PersistenceReleaseRecord[]
  readonly snapshots: readonly PersistenceSchemaInventory[]
}

function saveRecord(directory: string, record: PersistenceReleaseRecord): void {
  const block = dump(record, { lineWidth: -1, noRefs: true })
  for (const suffix of ['.md', '.zh.md']) {
    writeFileSync(join(directory, record.tag + suffix), `---\nkind: persistence-release\n---\n\n# Archived release\n\n\`\`\`yaml persistence-release\n${block}\`\`\`\n`)
  }
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'dsh-persistence-releases-'))
  temporary.push(root)
  const directory = join(root, 'docs/persistence-changes/releases')
  mkdirSync(directory, { recursive: true })
  const manifest: PersistenceReleaseManifest = {
    schemaVersion: 1, repository: 'deepseek-harness/deepseek-harness', capturedAt: '2026-09-12',
    releases: TAGS.map((tag, index) => ({
      tag, commit: String(index + 1).repeat(40), committedAt: '2026-09-01T10:00:00+08:00', publishedAt: index === 0 ? null : '2026-09-01T03:00:00Z',
      sessionFormatVersion: 0, sqliteSchemaVersion: index === 0 ? null : 2,
    })),
  }
  const before = event('string')
  const after = event('number')
  const header = rootSchema('SessionHeader', [
    { kind: 'object', indices: [], properties: [{ name: 'version', type: 1, optional: false }] }, { kind: 'primitive', type: 'number' },
  ])
  const snapshots = [inventory([
    header, rootSchema('JsonlHeaderLine', [{ kind: 'opaque', reason: 'unknown' }]),
    rootSchema('SessionEventEnvelope', [{ kind: 'object', indices: [], properties: [] }]), before,
  ]), inventory([after]), inventory([])]
  const records = manifest.releases.map((release, index): PersistenceReleaseRecord => ({
    schemaVersion: 1, tag: release.tag, commit: release.commit, previous: TAGS[index - 1] ?? null,
    sessionFormatVersion: release.sessionFormatVersion, sqliteSchemaVersion: release.sqliteSchemaVersion,
    changes: snapshots[index]!.roots.map(root => ({ root: root.key, before: index === 0 ? null : before.digest, after: root.digest })),
  }))
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest))
  for (const [index, record] of records.entries()) {
    saveRecord(directory, record)
    writeFileSync(join(directory, record.tag + '.schema.json'), JSON.stringify(snapshots[index]))
    writeFileSync(join(directory, record.tag + '.i18n.yaml'), 'schemaVersion: 1\n')
  }
  return { root, directory, manifest, records, snapshots }
}

function replaceSnapshot(fixture: Fixture, index: number, snapshot: PersistenceSchemaInventory): void {
  writeFileSync(join(fixture.directory, TAGS[index]! + '.schema.json'), JSON.stringify(snapshot))
}

describe('pinned persistence releases', () => {
  it('reconstructs breaking version-zero changes and unchanged releases from a tree without Git or package sources', () => {
    const data = fixture()
    const archive = loadPersistenceReleases(data.root)
    expect(archive.entries).toHaveLength(3)
    expect(archive.entries[0]!.roots.get('event:example/value')!.digest).toBe(event('string').digest)
    expect(archive.entries[1]!.roots.get('event:example/value')!.digest).toBe(event('number').digest)
    expect(archive.entries[1]!.differences).toEqual([expect.objectContaining({ root: 'event:example/value', kind: 'type-changed', requiresVersionBump: true })])
    expect(archive.entries[2]!.roots).toEqual(archive.entries[1]!.roots)
    expect(archive.entries[2]!.differences).toEqual([])
    expect(() => parsePersistenceSnapshot(data.snapshots[1])).toThrow('surface metadata')
  })

  it.each(['.md', '.zh.md', '.i18n.yaml', '.schema.json'])('rejects a missing manifest release companion %s', (suffix) => {
    const data = fixture()
    rmSync(join(data.directory, TAGS[1] + suffix))
    expect(() => loadPersistenceReleases(data.root)).toThrow('missing release artifact')
  })

  it.each(['orphan.md', 'orphan.schema.json', 'orphan.zh.md', 'orphan.i18n.yaml'])('rejects an unreferenced archive file %s', (filename) => {
    const data = fixture()
    writeFileSync(join(data.directory, filename), '{}')
    expect(() => loadPersistenceReleases(data.root)).toThrow('unreferenced persistence release artifact')
  })

  it('rejects missing, duplicated, and misordered manifest entries', () => {
    const data = fixture()
    for (const releases of [
      data.manifest.releases.slice(1), [data.manifest.releases[0], ...data.manifest.releases], [...data.manifest.releases].reverse(),
    ]) {
      writeFileSync(join(data.directory, 'manifest.json'), JSON.stringify({ ...data.manifest, releases }))
      expect(() => loadPersistenceReleases(data.root)).toThrow(/unreferenced|semantic-version order/u)
    }
  })

  it('rejects malformed manifest identities and version metadata', () => {
    const data = fixture()
    for (const changes of [
      { tag: 'dsh-v0.1.0-beta.1' }, { commit: '1234' }, { committedAt: '2026-09-01' },
      { publishedAt: 'yesterday' }, { sessionFormatVersion: -1 }, { sqliteSchemaVersion: 1.5 },
    ]) {
      writeFileSync(join(data.directory, 'manifest.json'), JSON.stringify({ ...data.manifest,
        releases: data.manifest.releases.map((release, index) => index === 0 ? { ...release, ...changes } : release),
      }))
      expect(() => loadPersistenceReleases(data.root)).toThrow(/invalid value|nonnegative integer/u)
    }
    for (const changes of [{ schemaVersion: 2 }, { repository: 'another/repository' }, { capturedAt: '2026-02-30' }, { releases: [] }]) {
      writeFileSync(join(data.directory, 'manifest.json'), JSON.stringify({ ...data.manifest, ...changes }))
      expect(() => loadPersistenceReleases(data.root)).toThrow(/schema version|unexpected repository|capture date|must not be empty/u)
    }
  })

  it('rejects wrong predecessor, commit, format version, schema version, and duplicate roots', () => {
    const data = fixture()
    const original = data.records[1]!
    for (const changed of [
      { ...original, previous: null }, { ...original, commit: 'a'.repeat(40) },
      { ...original, sessionFormatVersion: 2 }, { ...original, schemaVersion: 2 },
      { ...original, changes: [...original.changes, ...original.changes] },
    ]) {
      saveRecord(data.directory, changed as PersistenceReleaseRecord)
      expect(() => loadPersistenceReleases(data.root)).toThrow(/predecessor|match manifest|schema version|duplicate change/u)
    }
  })

  it('rejects before and after digest mismatches', () => {
    const data = fixture()
    const original = data.records[1]!
    for (const field of ['before', 'after']) {
      saveRecord(data.directory, { ...original, changes: original.changes.map(change => ({ ...change, [field]: 'f'.repeat(64) })) })
      expect(() => loadPersistenceReleases(data.root)).toThrow(`${field} digest mismatch`)
    }
  })

  it('rejects an unchanged transition and an unacknowledged after root', () => {
    const data = fixture()
    saveRecord(data.directory, { ...data.records[2]!, changes: [{ root: 'event:example/value', before: event('number').digest, after: event('number').digest }] })
    replaceSnapshot(data, 2, data.snapshots[1]!)
    expect(() => loadPersistenceReleases(data.root)).toThrow('unchanged transition')
    saveRecord(data.directory, data.records[2]!)
    expect(() => loadPersistenceReleases(data.root)).toThrow('snapshot roots')
  })

  it('reconstructs deletions without requiring an after schema or a historical version increase', () => {
    const data = fixture()
    saveRecord(data.directory, { ...data.records[2]!, changes: [{ root: 'event:example/value', before: event('number').digest, after: null }] })
    const result = loadPersistenceReleases(data.root)
    expect(result.entries[2]!.roots.has('event:example/value')).toBe(false)
    expect(result.entries[2]!.differences).toEqual([expect.objectContaining({ kind: 'root-removed', requiresVersionBump: true })])
  })

  it('rejects missing, duplicate, and unreferenced reachable types', () => {
    const data = fixture()
    const snapshot = data.snapshots[1]!
    const unrelated = inventory([rootSchema('SessionHeader', [{ kind: 'primitive', type: 'boolean' }])]).types[0]!
    for (const types of [snapshot.types.slice(1), [...snapshot.types, snapshot.types[0]!], [...snapshot.types, unrelated]]) {
      replaceSnapshot(data, 1, { ...snapshot, types })
      expect(() => loadPersistenceReleases(data.root)).toThrow(/every reachable type|duplicate schema type|unreferenced schema type/u)
    }
  })

  it('rejects mismatched translations, duplicate blocks, and the wrong document kind', () => {
    const data = fixture()
    const path = join(data.directory, TAGS[1] + '.zh.md')
    const source = readFileSync(path, 'utf8')
    for (const changed of [
      source.replace('schemaVersion: 1', 'schemaVersion: 2'), source + source,
      source.replace('kind: persistence-release', 'kind: persistence-change'),
    ]) {
      writeFileSync(path, changed)
      expect(() => loadPersistenceReleases(data.root)).toThrow(/bilingual machine|exactly one|frontmatter kind/u)
    }
  })

  it('matches literal header versions when a historical declaration pins one', () => {
    const data = fixture()
    const header = rootSchema('SessionHeader', [
      { kind: 'object', indices: [], properties: [{ name: 'version', type: 1, optional: false }] }, { kind: 'literal', value: 9 },
    ])
    const snapshot = inventory(data.snapshots[0]!.roots.map(root => root.key === header.key ? header : root))
    replaceSnapshot(data, 0, snapshot)
    saveRecord(data.directory, { ...data.records[0]!,
      changes: snapshot.roots.map(root => ({ root: root.key, before: null, after: root.digest })),
    })
    expect(() => loadPersistenceReleases(data.root)).toThrow('SessionHeader.version')
  })
})
