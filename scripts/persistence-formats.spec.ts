/** Format reference coverage follows the writer version and retains complete historical schemas. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dump } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { loadPersistenceFormats, runPersistenceFormats } from './persistence-formats.ts'
import { canonicalizeSchema, schemaDigest } from './persistence-schema-model.ts'
import type { PersistenceRoot, PersistenceSchemaInventory, PersistenceType, SchemaNode } from './persistence-schema-model.ts'

const temporary: string[] = []
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }) })

function rootSchema(metadata: Omit<PersistenceRoot, 'schema' | 'digest'>, nodes: readonly SchemaNode[]): PersistenceRoot {
  const schema = canonicalizeSchema(nodes, 0)
  return { ...metadata, schema, digest: schemaDigest(schema) }
}

function completeInventory(roots: readonly PersistenceRoot[]): PersistenceSchemaInventory {
  const types = new Map<string, PersistenceType>()
  for (const root of roots) {
    root.schema.nodes.forEach((_, index) => {
      const schema = canonicalizeSchema(root.schema.nodes, index)
      const digest = schemaDigest(schema)
      types.set(digest, { digest, schema, names: [], sources: [] })
    })
  }
  return { formatVersion: 1, roots, types: [...types.values()] }
}

function header(key: string, version: number | 'number', optional = false): PersistenceRoot {
  return rootSchema({ key, kind: 'header' }, [
    { kind: 'object', indices: [], properties: [{ name: 'version', type: 1, optional }] },
    version === 'number' ? { kind: 'primitive', type: 'number' } : { kind: 'literal', value: version },
  ])
}

function inventory(version: number): PersistenceSchemaInventory {
  return completeInventory([
    header('SessionHeader', version), header('JsonlHeaderLine', 'number'),
    rootSchema({ key: 'SessionEventEnvelope', kind: 'envelope' }, [{ kind: 'object', indices: [], properties: [] }]),
    rootSchema({ key: 'event:example/value', kind: 'event', event: 'example/value', surface: false }, [
      { kind: 'object', indices: [], properties: [{ name: 'type', type: 1, optional: false }, { name: 'data', type: 2, optional: false }] },
      { kind: 'literal', value: 'example/value' }, { kind: 'primitive', type: 'string' },
    ]),
  ])
}

function write(root: string, path: string, content: string): void {
  writeFileSync(join(root, path), content)
}

function schemaPath(version: number, currentVersion: number): string {
  return version === currentVersion ? 'docs/persistence-schema.json' : `docs/persistence-formats/v${version}.schema.json`
}

function replaceSnapshot(root: string, version: number, currentVersion: number, snapshot: PersistenceSchemaInventory): void {
  write(root, schemaPath(version, currentVersion), JSON.stringify(snapshot))
}

function saveReference(root: string, version: number, currentVersion: number, snapshot = inventory(version)): void {
  const current = version === currentVersion
  const filename = current ? 'persistence-catalog' : `persistence-formats/v${version}`
  const schemaName = current ? 'persistence-schema.json' : `v${version}.schema.json`
  const record = {
    schemaVersion: 1, sessionFormatVersion: version,
    source: version === 1 ? { pullRequest: 3349 } : { tag: 'dsh-v0.1.0-rc.5' },
    roots: Object.fromEntries(snapshot.roots.map(root => [root.key, root.digest])),
  }
  const lines = [
    ...current ? [] : ['---', 'kind: persistence-format', '---', '', '```yaml persistence-format', dump(record).trimEnd(), '```', ''],
    `# Session format v${version}`, '', `[Inventory](${schemaName})`, '', '| Root | Kind | SHA-256 |', '|---|---|---|',
    ...snapshot.roots.map(root => `| \`${root.key}\` | ${root.kind} | \`${root.digest}\` |`), '',
  ]
  for (const suffix of ['.md', '.zh.md']) write(root, `docs/${filename}${suffix}`, lines.join('\n'))
  replaceSnapshot(root, version, currentVersion, snapshot)
}

function fixture(currentVersion = 3): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-persistence-formats-'))
  temporary.push(root)
  mkdirSync(join(root, 'packages/core/session/src'), { recursive: true })
  mkdirSync(join(root, 'docs/persistence-formats'), { recursive: true })
  write(root, 'packages/core/session/src/types.ts', `export const SESSION_FORMAT_VERSION = ${currentVersion} as const\n`)
  for (let version = 0; version <= currentVersion; version += 1) saveReference(root, version, currentVersion)
  return root
}

function edit(root: string, path: string, from: string, to: string): void {
  const source = readFileSync(join(root, path), 'utf8')
  expect(source).toContain(from)
  write(root, path, source.replace(from, to))
}

function editPair(root: string, version: number, from: string, to: string): void {
  for (const suffix of ['.md', '.zh.md']) edit(root, `docs/persistence-formats/v${version}${suffix}`, from, to)
}

function prepareFacts(root: string, currentVersion = 3): void {
  for (const suffix of ['.md', '.zh.md']) {
    for (let version = 0; version < currentVersion; version += 1) {
      const path = `docs/persistence-formats/v${version}${suffix}`
      const switcher = suffix === '.md' ? `English | [中文](v${version}.zh.md)` : `[English](v${version}.md) | 中文`
      write(root, path, readFileSync(join(root, path), 'utf8') + `\n${switcher}\n\n<!-- persistence-format-schema:start -->\n\nPending schemas.\n\n<!-- persistence-format-schema:end -->\n`)
    }
    const switcher = suffix === '.md' ? 'English | [中文](README.zh.md)' : '[English](README.md) | 中文'
    write(root, `docs/persistence-formats/README${suffix}`, `# Session formats\n\n${switcher}\n\nAuthored context.\n\n<!-- persistence-format-index:start -->\n\nPending formats.\n\n<!-- persistence-format-index:end -->\n`)
  }
}

describe('complete persistence format references', () => {
  it('loads a contiguous archive and the current catalog without Git or historical package sources', () => {
    const formats = loadPersistenceFormats(fixture())
    expect(formats.currentVersion).toBe(3)
    expect(formats.entries.map(entry => entry.version)).toEqual([0, 1, 2, 3])
    expect(formats.entries[0]?.source).toEqual({ tag: 'dsh-v0.1.0-rc.5' })
    expect(formats.entries[1]?.source).toEqual({ pullRequest: 3349 })
    expect(formats.entries[3]).toMatchObject({ document: 'docs/persistence-catalog.md', schemaPath: 'docs/persistence-schema.json' })
    expect(formats.entries[3]?.source).toBeUndefined()
  })

  it('accepts a version-zero writer without a historical directory', () => {
    const root = fixture(0)
    rmSync(join(root, 'docs/persistence-formats'), { recursive: true })
    expect(loadPersistenceFormats(root).entries).toHaveLength(1)
  })

  it.each(['.md', '.zh.md', '.schema.json'])('requires every historical companion %s', (suffix) => {
    const root = fixture()
    rmSync(join(root, `docs/persistence-formats/v1${suffix}`))
    expect(() => loadPersistenceFormats(root)).toThrow(`missing persistence format artifact v1${suffix}`)
  })

  it('rejects a gap even when all remaining versions have complete companions', () => {
    const root = fixture()
    for (const suffix of ['.md', '.zh.md', '.schema.json']) rmSync(join(root, `docs/persistence-formats/v1${suffix}`))
    expect(() => loadPersistenceFormats(root)).toThrow('v1: missing persistence format artifact')
  })

  it.each(['persistence-catalog.md', 'persistence-catalog.zh.md', 'persistence-schema.json'])('requires the current reference artifact %s', (filename) => {
    const root = fixture()
    rmSync(join(root, `docs/${filename}`))
    expect(() => loadPersistenceFormats(root)).toThrow(`missing persistence format artifact docs/${filename}`)
  })

  it('requires a formerly current archive when the writer advances', () => {
    const root = fixture()
    write(root, 'packages/core/session/src/types.ts', 'export const SESSION_FORMAT_VERSION = 4 as const\n')
    saveReference(root, 4, 4)
    expect(() => loadPersistenceFormats(root)).toThrow('v3: missing persistence format artifact')
    saveReference(root, 3, 4)
    expect(loadPersistenceFormats(root).entries.map(entry => entry.version)).toEqual([0, 1, 2, 3, 4])
  })

  it.each(['v3.md', 'v9.schema.json', 'v01.md', 'v-1.md', 'v2.schema.yaml', 'v3.i18n.yaml'])('rejects unexpected or duplicate format filename %s', (filename) => {
    const root = fixture()
    write(root, `docs/persistence-formats/${filename}`, '{}')
    expect(() => loadPersistenceFormats(root)).toThrow(`unexpected persistence format artifact ${filename}`)
  })

  it('rejects bilingual declarations that differ', () => {
    const root = fixture()
    edit(root, 'docs/persistence-formats/v1.zh.md', 'pullRequest: 3349', 'pullRequest: 3397')
    expect(() => loadPersistenceFormats(root)).toThrow('bilingual machine records differ')
  })

  it.each([
    ['kind: persistence-format', 'kind: persistence-release', 'frontmatter kind'],
    ['sessionFormatVersion: 1', 'sessionFormatVersion: 0', 'must match its filename'],
    ['schemaVersion: 1', 'schemaVersion: 2', 'unsupported persistence format record schema version'],
    ['pullRequest: 3349', 'pullRequest: 0', 'positive integer'],
    ['pullRequest: 3349', 'pullRequest: 1.5', 'positive integer'],
    ['pullRequest: 3349', 'pullRequest: 3349\n  tag: dsh-v0.1.0', 'expected fields'],
    ['pullRequest: 3349', 'other: 3349', 'expected fields'],
    ['source:\n  pullRequest: 3349', 'source: null', 'expected an object'],
    ['schemaVersion: 1', 'schemaVersion: 1\nunknown: true', 'expected fields'],
  ])('rejects inconsistent machine data: %s', (from, to, error) => {
    const root = fixture()
    editPair(root, 1, from, to)
    expect(() => loadPersistenceFormats(root)).toThrow(error)
  })

  it('rejects a source tag outside the DSH release namespace', () => {
    const root = fixture()
    editPair(root, 0, 'tag: dsh-v0.1.0-rc.5', 'tag: latest')
    expect(() => loadPersistenceFormats(root)).toThrow('invalid source tag')
  })

  it.each(['missing', 'extra', 'wrong-digest'])('rejects a %s recorded root', (variant) => {
    const root = fixture()
    const digest = inventory(1).roots[0]!.digest
    const from = variant === 'extra' ? 'roots:\n' : `  SessionHeader: ${digest}\n`
    const to = variant === 'missing' ? '' : variant === 'extra' ? `roots:\n  event:undeclared: ${'f'.repeat(64)}\n`
      : `  SessionHeader: ${'f'.repeat(64)}\n`
    editPair(root, 1, from, to)
    expect(() => loadPersistenceFormats(root)).toThrow('recorded roots do not match the complete schema inventory')
  })

  it.each(['unknown-key', 'invalid-digest', 'duplicate-key', 'not-a-mapping'])('rejects invalid recorded roots: %s', (variant) => {
    const root = fixture()
    const digest = inventory(1).roots[0]!.digest
    const from = variant === 'not-a-mapping' ? dump({ roots: Object.fromEntries(inventory(1).roots.map(root => [root.key, root.digest])) })
      : `  SessionHeader: ${digest}\n`
    const to = variant === 'unknown-key' ? `  unknown: ${digest}\n` : variant === 'invalid-digest' ? '  SessionHeader: invalid\n'
      : variant === 'duplicate-key' ? from + from : 'roots: []\n'
    editPair(root, 1, from, to)
    expect(() => loadPersistenceFormats(root)).toThrow(variant === 'duplicate-key' ? 'duplicated mapping key'
      : variant === 'not-a-mapping' ? 'roots must be a mapping' : 'invalid recorded root')
  })

  it.each(['missing', 'duplicate'])('rejects a %s machine block', (variant) => {
    const root = fixture()
    for (const suffix of ['.md', '.zh.md']) {
      const path = `docs/persistence-formats/v1${suffix}`
      const text = readFileSync(join(root, path), 'utf8')
      write(root, path, variant === 'missing' ? text.replace('```yaml persistence-format', '```yaml') : text + '\n```yaml persistence-format\n{}\n```\n')
    }
    expect(() => loadPersistenceFormats(root)).toThrow('expected exactly one persistence-format machine record')
  })

  it.each(['SessionHeader', 'JsonlHeaderLine', 'SessionEventEnvelope', 'event:example/value'])('rejects an inventory missing %s', (key) => {
    const root = fixture()
    replaceSnapshot(root, 1, 3, completeInventory(inventory(1).roots.filter(root => root.key !== key)))
    expect(() => loadPersistenceFormats(root)).toThrow(key.startsWith('event:') ? 'must include an event root' : `missing schema root ${key}`)
  })

  it.each([0, 1, 2, 3])('rejects a mismatched header version at v%s', (version) => {
    const root = fixture()
    replaceSnapshot(root, version, 3, completeInventory(inventory(version).roots.map(root => root.key === 'SessionHeader' ? header(root.key, version + 1) : root)))
    expect(() => loadPersistenceFormats(root)).toThrow('SessionHeader.version must match')
  })

  it('retains historical number declarations but requires the current logical header literal', () => {
    const root = fixture()
    for (const version of [0, 1, 2]) {
      saveReference(root, version, 3, completeInventory(inventory(version).roots.map(root => root.key === 'SessionHeader' ? header(root.key, 'number') : root)))
    }
    expect(loadPersistenceFormats(root).entries).toHaveLength(4)
    replaceSnapshot(root, 3, 3, completeInventory(inventory(3).roots.map(root => root.key === 'SessionHeader' ? header(root.key, 'number') : root)))
    expect(() => loadPersistenceFormats(root)).toThrow('SessionHeader.version must match the current writer version')
  })

  it.each(['SessionHeader', 'JsonlHeaderLine'])('requires a present %s version property', (key) => {
    const root = fixture()
    replaceSnapshot(root, 1, 3, completeInventory(inventory(1).roots.map(root => root.key === key ? header(key, 1, true) : root)))
    expect(() => loadPersistenceFormats(root)).toThrow(`${key}.version must match`)
  })

  it('uses historical surface rules only for historical references', () => {
    const root = fixture()
    const event = rootSchema({ key: 'event:example/value', kind: 'event', event: 'example/value', surface: true }, [
      { kind: 'object', indices: [], properties: [
        { name: 'type', type: 1, optional: false }, { name: 'surfaceOp', type: 2, optional: true },
      ] },
      { kind: 'literal', value: 'example/value' }, { kind: 'primitive', type: 'string' },
    ])
    saveReference(root, 1, 3, completeInventory(inventory(1).roots.map(root => root.kind === 'event' ? event : root)))
    expect(loadPersistenceFormats(root).entries).toHaveLength(4)
    replaceSnapshot(root, 3, 3, completeInventory(inventory(3).roots.map(root => root.kind === 'event' ? event : root)))
    expect(() => loadPersistenceFormats(root)).toThrow('surface metadata does not match its schema')
  })

  it.each(['missing', 'duplicate', 'extra'])('rejects %s reachable type coverage', (variant) => {
    const root = fixture()
    const original = inventory(1)
    const extraSchema = canonicalizeSchema([{ kind: 'literal', value: 'unreferenced' }], 0)
    const types = variant === 'missing' ? original.types.slice(1)
      : variant === 'duplicate' ? [...original.types, original.types[0]!]
        : [...original.types, { schema: extraSchema, digest: schemaDigest(extraSchema), names: [], sources: [] }]
    replaceSnapshot(root, 1, 3, { ...original, types })
    expect(() => loadPersistenceFormats(root)).toThrow(variant === 'missing' ? 'cover every reachable type' : variant === 'duplicate' ? 'duplicate schema type' : 'unreferenced schema type')
  })

  it('permits extractor-retained unreachable types only in the current inventory', () => {
    const root = fixture()
    const original = inventory(3)
    const schema = canonicalizeSchema([{ kind: 'literal', value: false }], 0)
    replaceSnapshot(root, 3, 3, {
      ...original, types: [...original.types, { schema, digest: schemaDigest(schema), names: [], sources: [] }],
    })
    expect(loadPersistenceFormats(root).entries).toHaveLength(4)
  })

  it.each(['duplicate-root', 'invalid-digest', 'invalid-graph', 'unexpected-field'])('rejects malformed schema inventory: %s', (variant) => {
    const root = fixture()
    const original = inventory(1)
    const first = original.roots[0]!
    const changed = variant === 'duplicate-root' ? { ...original, roots: [...original.roots, first] }
      : variant === 'invalid-digest' ? { ...original, roots: [{ ...first, digest: '0'.repeat(64) }, ...original.roots.slice(1)] }
        : variant === 'invalid-graph' ? { ...original, roots: [{ ...first, schema: { root: 0, nodes: [{ kind: 'array', element: 99 }] } }, ...original.roots.slice(1)] }
          : { ...original, extra: true }
    write(root, schemaPath(1, 3), JSON.stringify(changed))
    expect(() => loadPersistenceFormats(root)).toThrow(variant === 'duplicate-root' ? 'duplicate schema root' : variant === 'invalid-digest' ? 'schema digest mismatch' : variant === 'invalid-graph' ? 'unknown schema node' : 'unknown field extra')
  })

  it.each(['persistence-formats/v1.md', 'persistence-formats/v1.zh.md', 'persistence-catalog.md', 'persistence-catalog.zh.md'])('requires the matching schema link in %s', (document) => {
    const root = fixture()
    const schema = document.startsWith('persistence-formats/') ? 'v1.schema.json' : 'persistence-schema.json'
    edit(root, `docs/${document}`, `](${schema})`, '](wrong.schema.json)')
    expect(() => loadPersistenceFormats(root)).toThrow(`missing link to ${schema}`)
  })

  it.each(['persistence-catalog.md', 'persistence-catalog.zh.md'])('rejects a placeholder current catalog in %s', (document) => {
    const root = fixture()
    write(root, `docs/${document}`, '# Placeholder\n\n[Inventory](persistence-schema.json)\n')
    expect(() => loadPersistenceFormats(root)).toThrow('missing schema index entry for SessionHeader')
  })

  it('checks generated schema regions and refreshes them without changing the recorded schemas or authored context', () => {
    const root = fixture()
    prepareFacts(root)
    const paths = [0, 1, 2, 3].map(version => schemaPath(version, 3))
    const before = paths.map(path => readFileSync(join(root, path), 'utf8'))
    expect(() => runPersistenceFormats([], root)).toThrow('Stale persistence format facts')
    expect(runPersistenceFormats(['--write'], root)).toContain('Refreshed')
    expect(runPersistenceFormats([], root)).toBe('Persistence formats: v0 through v3 verified (4 complete references).')
    expect(paths.map(path => readFileSync(join(root, path), 'utf8'))).toEqual(before)
    expect(readFileSync(join(root, 'docs/persistence-formats/README.md'), 'utf8')).toContain('Authored context.')
    expect(readFileSync(join(root, 'docs/persistence-formats/v1.md'), 'utf8')).toContain('pullRequest: 3349')
    edit(root, 'docs/persistence-formats/v1.md', '<summary>Complete resolved types</summary>', '<summary>Missing definitions</summary>')
    expect(() => runPersistenceFormats([], root)).toThrow('Stale persistence format facts')
  })

  it('renders a format index for a current version-zero writer', () => {
    const root = fixture(0)
    prepareFacts(root, 0)
    runPersistenceFormats(['--write'], root)
    expect(runPersistenceFormats([], root)).toBe('Persistence formats: v0 through v0 verified (1 complete references).')
  })

  it.each(['missing', 'stale'])('rejects a %s format pairing record and refreshes it with --write', (variant) => {
    const root = fixture()
    prepareFacts(root)
    runPersistenceFormats(['--write'], root)
    const sidecar = 'docs/persistence-formats/v1.i18n.yaml'
    if (variant === 'missing') rmSync(join(root, sidecar))
    else write(root, sidecar, 'schemaVersion: 1\n')
    expect(() => runPersistenceFormats([], root)).toThrow(`Stale persistence format facts: ${sidecar}`)
    runPersistenceFormats(['--write'], root)
    expect(() => runPersistenceFormats([], root)).not.toThrow()
  })

  it('refuses to refresh facts until every format reference passes validation', () => {
    const root = fixture()
    prepareFacts(root)
    const index = readFileSync(join(root, 'docs/persistence-formats/README.md'), 'utf8')
    rmSync(join(root, 'docs/persistence-formats/v1.schema.json'))
    expect(() => runPersistenceFormats(['--write'], root)).toThrow('missing persistence format artifact')
    expect(readFileSync(join(root, 'docs/persistence-formats/README.md'), 'utf8')).toBe(index)
  })

  it('refuses to refresh an archive after an event and all its types are removed from its schema', () => {
    const root = fixture()
    const retained = rootSchema({ key: 'event:example/retained', kind: 'event', event: 'example/retained', surface: false }, [
      { kind: 'object', indices: [], properties: [{ name: 'type', type: 1, optional: false }] },
      { kind: 'literal', value: 'example/retained' },
    ])
    const complete = completeInventory([...inventory(1).roots, retained])
    saveReference(root, 1, 3, complete)
    prepareFacts(root)
    runPersistenceFormats(['--write'], root)
    const document = 'docs/persistence-formats/v1.md'
    const before = readFileSync(join(root, document), 'utf8')
    replaceSnapshot(root, 1, 3, completeInventory(complete.roots.filter(root => root.key !== 'event:example/value')))
    expect(() => runPersistenceFormats(['--write'], root)).toThrow('recorded roots do not match the complete schema inventory')
    expect(readFileSync(join(root, document), 'utf8')).toBe(before)
  })
})
