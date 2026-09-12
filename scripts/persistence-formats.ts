/** Verify complete Session format references from version zero through the current writer. */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { JSON_SCHEMA, load } from 'js-yaml'
import { readCurrentSessionFormatVersion } from './gen-session-format-catalog.ts'
import { parseHistoricalPersistenceSnapshot, parsePersistenceSnapshot } from './persistence-changes.ts'
import { persistenceFormatFactArtifacts } from './persistence-format-facts.ts'
import { canonicalizeSchema, schemaDigest } from './persistence-schema-model.ts'
import type { PersistenceSchemaInventory } from './persistence-schema-model.ts'

const DIRECTORY = 'docs/persistence-formats'
const CURRENT_DOCUMENT = 'docs/persistence-catalog.md'
const CURRENT_SCHEMA = 'docs/persistence-schema.json'

/** Historical checkout that supplies a format's complete declared persistence inventory. */
export type PersistenceFormatSource = { readonly tag: string } | { readonly pullRequest: number }

/** One complete format reference; the current catalog follows the historical entries. */
export interface PersistenceFormatEntry {
  readonly version: number
  readonly document: string
  readonly schemaPath: string
  readonly inventory: PersistenceSchemaInventory
  readonly source?: PersistenceFormatSource
}

/** Contiguous format references ending at the source-declared writer version. */
export interface PersistenceFormats {
  readonly currentVersion: number
  readonly entries: readonly PersistenceFormatEntry[]
}

interface PersistenceFormatRecord {
  readonly source: PersistenceFormatSource
  readonly roots: ReadonlyMap<string, string>
}

function fields(value: unknown, expected: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: expected an object`)
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== expected.length || expected.some(key => !Object.hasOwn(record, key))) {
    throw new Error(`${label}: expected fields ${expected.join(', ')}`)
  }
  return record
}

function machineBlock(document: string, label: string): string {
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(document)?.[1]
  const metadata: unknown = frontmatter === undefined ? undefined : load(frontmatter, { schema: JSON_SCHEMA })
  if (metadata === null || typeof metadata !== 'object' || !('kind' in metadata) || metadata.kind !== 'persistence-format') {
    throw new Error(`${label}: expected persistence-format frontmatter kind`)
  }
  const blocks = [...document.matchAll(/^```yaml persistence-format[^\S\n]*\n([\s\S]*?)^```[^\S\n]*$/gmu)]
  if (blocks.length !== 1) throw new Error(`${label}: expected exactly one persistence-format machine record`)
  return (blocks[0] as RegExpMatchArray)[1] as string
}

function parseSource(source: unknown, label: string): PersistenceFormatSource {
  if (source !== null && typeof source === 'object' && 'tag' in source) {
    const tag = fields(source, ['tag'], `${label} source`).tag
    if (typeof tag !== 'string' || !/^dsh-[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(tag)) throw new Error(`${label}: invalid source tag`)
    return { tag }
  }
  const pullRequest = fields(source, ['pullRequest'], `${label} source`).pullRequest
  if (!Number.isSafeInteger(pullRequest) || (pullRequest as number) <= 0) throw new Error(`${label}: source pullRequest must be a positive integer`)
  return { pullRequest: pullRequest as number }
}

function parseRecord(block: string, version: number): PersistenceFormatRecord {
  const label = `v${version}`
  const record = fields(load(block, { schema: JSON_SCHEMA }), ['schemaVersion', 'sessionFormatVersion', 'source', 'roots'], label)
  if (record.schemaVersion !== 1) throw new Error(`${label}: unsupported persistence format record schema version`)
  if (record.sessionFormatVersion !== version) throw new Error(`${label}: record sessionFormatVersion must match its filename`)
  if (record.roots === null || typeof record.roots !== 'object' || Array.isArray(record.roots)) throw new Error(`${label}: roots must be a mapping`)
  const roots = new Map<string, string>()
  for (const [key, digest] of Object.entries(record.roots)) {
    if (!/^(?:SessionHeader|JsonlHeaderLine|SessionEventEnvelope|event:.+)$/u.test(key)
      || typeof digest !== 'string' || !/^[a-f0-9]{64}$/u.test(digest)) throw new Error(`${label}: invalid recorded root ${key}`)
    roots.set(key, digest)
  }
  return { source: parseSource(record.source, label), roots }
}

function validateInventory(inventory: PersistenceSchemaInventory, version: number, current: boolean): void {
  const label = `v${version}`
  for (const key of ['SessionHeader', 'JsonlHeaderLine', 'SessionEventEnvelope']) {
    const root = inventory.roots.find(root => root.key === key)
    if (root === undefined) throw new Error(`${label}: missing schema root ${key}`)
    if (root.kind !== 'header') continue
    const node = root.schema.nodes[0]
    const field = node?.kind === 'object' ? node.properties.find(property => property.name === 'version') : undefined
    const type = field === undefined ? undefined : root.schema.nodes[field.type]
    const legacyNumber = !(current && key === 'SessionHeader') && type?.kind === 'primitive' && type.type === 'number'
    if (field?.optional !== false || !(legacyNumber || type?.kind === 'literal' && type.value === version)) {
      throw new Error(`${label}: ${key}.version must match the ${current ? 'current writer' : 'recorded format'} version`)
    }
  }
  if (!inventory.roots.some(root => root.kind === 'event')) throw new Error(`${label}: complete inventory must include an event root`)
  const reachable = new Set(inventory.roots.flatMap(root => root.schema.nodes
    .map((_, index) => schemaDigest(canonicalizeSchema(root.schema.nodes, index)))))
  const remaining = new Set(reachable)
  const listed = new Set<string>()
  for (const type of inventory.types) {
    if (listed.has(type.digest)) throw new Error(`${label}: duplicate schema type ${type.digest}`)
    listed.add(type.digest)
    // The current extractor can retain types erased by normalization; its generator gate checks that inventory.
    if (!current && !reachable.has(type.digest)) throw new Error(`${label}: unreferenced schema type ${type.digest}`)
    remaining.delete(type.digest)
  }
  if (remaining.size > 0) throw new Error(`${label}: schema types must cover every reachable type`)
}

function validateDocument(
  document: string, schemaName: string, inventory: PersistenceSchemaInventory, label: string, current: boolean,
): void {
  if (!document.includes(`](${schemaName})`)) throw new Error(`${label}: missing link to ${schemaName}`)
  if (!current) return
  for (const root of inventory.roots) {
    const row = `| \`${root.key}\` | ${root.kind} | \`${root.digest}\` |`
    if (!document.includes(row)) throw new Error(`${label}: missing schema index entry for ${root.key}`)
  }
}

/**
 * Read every required format pair and complete inventory without Git or historical source extraction.
 * @param root - checkout root containing the writer declaration and format references.
 * @returns ordered historical references followed by the current generated catalog.
 */
export function loadPersistenceFormats(root: string): PersistenceFormats {
  const currentVersion = readCurrentSessionFormatVersion(root)
  const directory = join(root, DIRECTORY)
  const files = new Set(existsSync(directory) ? readdirSync(directory) : [])
  const expected = new Set<string>()
  for (let version = 0; version < currentVersion; version += 1) {
    for (const suffix of ['.md', '.zh.md', '.schema.json']) {
      const name = `v${version}${suffix}`
      expected.add(name)
      if (!files.has(name)) throw new Error(`v${version}: missing persistence format artifact ${name}`)
    }
    expected.add(`v${version}.i18n.yaml`)
  }
  for (const file of files) {
    if (file.startsWith('v') && !expected.has(file)) throw new Error(`unexpected persistence format artifact ${file}`)
  }
  const read = (path: string): string => {
    if (!existsSync(join(root, path))) throw new Error(`missing persistence format artifact ${path}`)
    return readFileSync(join(root, path), 'utf8').replaceAll('\r\n', '\n')
  }
  const entries: PersistenceFormatEntry[] = []
  for (let version = 0; version <= currentVersion; version += 1) {
    const current = version === currentVersion
    const document = current ? CURRENT_DOCUMENT : `${DIRECTORY}/v${version}.md`
    const schemaPath = current ? CURRENT_SCHEMA : `${DIRECTORY}/v${version}.schema.json`
    const english = read(document)
    const chinese = read(document.replace(/\.md$/u, '.zh.md'))
    let record: PersistenceFormatRecord | undefined
    if (!current) {
      const block = machineBlock(english, document)
      if (block !== machineBlock(chinese, document.replace(/\.md$/u, '.zh.md'))) throw new Error(`v${version}: bilingual machine records differ`)
      record = parseRecord(block, version)
    }
    const inventory = (current ? parsePersistenceSnapshot : parseHistoricalPersistenceSnapshot)(JSON.parse(read(schemaPath)))
    validateInventory(inventory, version, current)
    const recordedRoots = record?.roots
    if (recordedRoots !== undefined && (recordedRoots.size !== inventory.roots.length
      || inventory.roots.some(root => recordedRoots.get(root.key) !== root.digest))) {
      throw new Error(`v${version}: recorded roots do not match the complete schema inventory`)
    }
    const schemaName = current ? 'persistence-schema.json' : `v${version}.schema.json`
    validateDocument(english, schemaName, inventory, document, current)
    validateDocument(chinese, schemaName, inventory, document.replace(/\.md$/u, '.zh.md'), current)
    entries.push({ version, document, schemaPath, inventory, ...(record === undefined ? {} : { source: record.source }) })
  }
  return { currentVersion, entries }
}

/**
 * Validate format coverage and check or refresh the historical schema and index regions.
 * @param args - CLI arguments; --write refreshes generated facts after complete validation.
 * @param root - default checkout directory, overridden by --root when provided.
 * @returns the verified format count and optional number of refreshed artifacts.
 */
export function runPersistenceFormats(args: readonly string[], root = resolve(import.meta.dirname, '..')): string {
  const { values } = parseArgs({ args: [...args], options: { root: { type: 'string' }, write: { type: 'boolean' } } })
  root = resolve(values.root ?? root)
  const formats = loadPersistenceFormats(root)
  const changed = persistenceFormatFactArtifacts(root, formats).filter(artifact => !existsSync(join(root, artifact.path))
    || readFileSync(join(root, artifact.path), 'utf8') !== artifact.content)
  if (!values.write && changed.length > 0) throw new Error(`Stale persistence format facts: ${changed.map(artifact => artifact.path).join(', ')}. Run pnpm run verify-persistence-formats --write.`)
  if (values.write) for (const artifact of changed) writeFileSync(join(root, artifact.path), artifact.content)
  return `Persistence formats: v0 through v${formats.currentVersion} verified (${formats.entries.length} complete references).`
    + (values.write ? ` Refreshed ${changed.length} file${changed.length === 1 ? '' : 's'}.` : '')
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  try {
    console.log(runPersistenceFormats(process.argv.slice(2)))
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
