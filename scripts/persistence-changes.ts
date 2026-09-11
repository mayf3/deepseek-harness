/** Verify and acknowledge persistence type changes from current-tree schema history. */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { JSON_SCHEMA, load } from 'js-yaml'
import { canonicalizeSchema, schemaDigest } from './persistence-schema-model.ts'
import type { CanonicalSchema, PersistenceRoot, PersistenceSchemaInventory, SchemaNode, SchemaTupleElement } from './persistence-schema-model.ts'
import { extractPersistenceSchema } from './persistence-schema.ts'

const HISTORY_DIRECTORY = 'docs/persistence-changes'
const CURRENT_SCHEMA = 'docs/persistence-schema.json'
const ID_PATTERN = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/u
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u
const EXPLANATION_PLACEHOLDER = 'TODO: explain this change.'
const EVIDENCE_PLACEHOLDER = 'TODO: record validation evidence.'

/** The author's acknowledgement of one mechanically classified transition. */
export type PersistenceDecision = 'same-version' | 'version-bump'

/** One root's successor; null after values preserve a deletion in its history. */
export interface PersistenceChange {
  readonly root: string
  readonly previous: string | null
  readonly after: string | null
  readonly decision: PersistenceDecision
}

/** A document's machine record, independent of its translated prose. */
export interface PersistenceChangeRecord {
  readonly schemaVersion: 1
  readonly id: string
  readonly baseline: boolean
  readonly changes: readonly PersistenceChange[]
}

/** A parsed acknowledgement and its self-contained after schemas. */
export interface PersistenceHistoryEntry {
  readonly record: PersistenceChangeRecord
  readonly snapshot: PersistenceSchemaInventory
}

/** One detected type change, with a path that reviewers can locate. */
export interface PersistenceTypeChange {
  readonly path: string
  readonly description: string
  readonly requiresVersionBump: boolean
}

interface Tip {
  readonly id: string
  readonly root: PersistenceRoot | null
}

/** Verified per-root history tips; historical schemas need not match the current tree. */
export interface PersistenceHistory {
  readonly entries: readonly PersistenceHistoryEntry[]
  readonly tips: ReadonlyMap<string, Tip>
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function keys(value: Record<string, unknown>, expected: readonly string[], label: string, optional: readonly string[] = []): void {
  const missing = expected.find(key => !Object.hasOwn(value, key))
  const unexpected = Object.keys(value).find(key => !expected.includes(key) && !optional.includes(key))
  if (missing !== undefined || unexpected !== undefined) throw new Error(`${label}: ${missing === undefined ? `unknown field ${unexpected}` : `missing field ${missing}`}`)
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value
}

function textValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`)
  return value
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`)
  return value
}

function identifier(value: unknown, label: string): string {
  const id = textValue(value, label)
  if (!ID_PATTERN.test(id)) throw new Error(`${label} must be YYYY-MM-DD-slug`)
  return id
}

function digest(value: unknown, label: string): string {
  const result = textValue(value, label)
  if (!DIGEST_PATTERN.test(result)) throw new Error(`${label} must be a SHA-256 digest`)
  return result
}

function reference(value: unknown, count: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= count) throw new Error(`${label} references an unknown schema node`)
  return value as number
}

function parseSchema(value: unknown, label: string): CanonicalSchema {
  const input = record(value, label)
  keys(input, ['root', 'nodes'], label)
  if (input.root !== 0) throw new Error(`${label}.root must be zero`)
  const nodes = array(input.nodes, `${label}.nodes`)
  if (nodes.length === 0) throw new Error(`${label}.nodes must not be empty`)
  const ref = (value: unknown): number => reference(value, nodes.length, label)
  for (const [index, raw] of nodes.entries()) {
    const node = record(raw, `${label}.nodes[${index}]`)
    switch (node.kind) {
      case 'primitive':
        keys(node, ['kind', 'type'], label)
        if (!['null', 'boolean', 'number', 'string', 'never'].includes(String(node.type))) throw new Error(`${label}: invalid primitive`)
        break
      case 'literal':
        keys(node, ['kind', 'value'], label)
        if (!['string', 'boolean', 'number'].includes(typeof node.value)
          || typeof node.value === 'number' && !Number.isFinite(node.value)) throw new Error(`${label}: invalid literal`)
        break
      case 'opaque':
        keys(node, ['kind', 'reason'], label)
        if (!['any', 'unknown'].includes(String(node.reason))) throw new Error(`${label}: invalid opaque reason`)
        break
      case 'array':
        keys(node, ['kind', 'element'], label)
        ref(node.element)
        break
      case 'tuple':
        keys(node, ['kind', 'elements'], label)
        for (const rawElement of array(node.elements, label)) {
          const element = record(rawElement, label)
          keys(element, ['type', 'optional', 'rest'], label)
          ref(element.type)
          bool(element.optional, label)
          bool(element.rest, label)
        }
        break
      case 'object': {
        keys(node, ['kind', 'properties', 'indices'], label)
        const names = new Set<string>()
        for (const rawProperty of array(node.properties, label)) {
          const property = record(rawProperty, label)
          keys(property, ['name', 'type', 'optional'], label)
          if (typeof property.name !== 'string') throw new Error(`${label}: property name must be a string`)
          const name = property.name
          if (names.has(name)) throw new Error(`${label}: duplicate property ${name}`)
          names.add(name)
          ref(property.type)
          bool(property.optional, label)
        }
        for (const rawIndex of array(node.indices, label)) {
          const entry = record(rawIndex, label)
          keys(entry, ['key', 'value'], label)
          ref(entry.key)
          ref(entry.value)
        }
        break
      }
      case 'union':
        keys(node, ['kind', 'types'], label)
        if (array(node.types, label).length === 0) throw new Error(`${label}: empty union`)
        for (const item of node.types as unknown[]) ref(item)
        break
      default:
        throw new Error(`${label}: unknown schema node kind ${String(node.kind)}`)
    }
  }
  const schema = input as unknown as CanonicalSchema
  const canonical = canonicalizeSchema(schema.nodes, schema.root)
  if (JSON.stringify(canonical) !== JSON.stringify(schema)) throw new Error(`${label}: schema is not canonical`)
  return schema
}

/** Parse a persisted schema inventory, rejecting malformed graphs and digest drift.
 * @param value - JSON read from a current or historical schema file.
 * @returns the validated inventory.
 */
export function parsePersistenceSnapshot(value: unknown): PersistenceSchemaInventory {
  const input = record(value, 'schema inventory')
  keys(input, ['formatVersion', 'roots', 'types'], 'schema inventory')
  if (input.formatVersion !== 1) throw new Error('unsupported persistence schema normalization version')
  const names = new Set<string>()
  for (const rawRoot of array(input.roots, 'schema roots')) {
    const root = record(rawRoot, 'schema root')
    keys(root, ['key', 'kind', 'digest', 'schema'], 'schema root', ['event', 'surface'])
    const key = textValue(root.key, 'root key')
    if (names.has(key)) throw new Error(`duplicate schema root ${key}`)
    names.add(key)
    if (root.kind === 'event') {
      if (key !== `event:${textValue(root.event, 'event name')}`) throw new Error(`invalid event root key ${key}`)
      bool(root.surface, 'event surface membership')
    } else if ((root.kind !== 'header' || !['SessionHeader', 'JsonlHeaderLine'].includes(key))
      && (root.kind !== 'envelope' || key !== 'SessionEventEnvelope')) throw new Error(`invalid schema root ${key}`)
    if (root.kind !== 'event' && (root.event !== undefined || root.surface !== undefined)) throw new Error(`${key}: non-event metadata`)
    const schema = parseSchema(root.schema, key)
    if (root.kind === 'event') validateEventMetadata(schema, String(root.event), root.surface === true)
    if (digest(root.digest, `${key} digest`) !== schemaDigest(schema)) throw new Error(`${key}: schema digest mismatch`)
  }
  for (const rawType of array(input.types, 'schema types')) {
    const type = record(rawType, 'schema type')
    keys(type, ['digest', 'schema', 'names', 'sources'], 'schema type')
    const schema = parseSchema(type.schema, 'shared schema')
    if (digest(type.digest, 'shared digest') !== schemaDigest(schema)) throw new Error('shared schema digest mismatch')
    for (const name of array(type.names, 'type names')) textValue(name, 'type name')
    for (const source of array(type.sources, 'type sources')) textValue(source, 'type source')
  }
  return input as unknown as PersistenceSchemaInventory
}

function validateEventMetadata(schema: CanonicalSchema, event: string, surface: boolean): void {
  const pending = [0]
  const visited = new Set<number>()
  while (pending.length > 0) {
    const index = pending.pop() as number
    if (visited.has(index)) continue
    visited.add(index)
    const node = schema.nodes[index] as SchemaNode
    if (node.kind === 'union') { pending.push(...node.types); continue }
    if (node.kind !== 'object') throw new Error(`${event}: event schema must be an object`)
    const tag = node.properties.find(property => property.name === 'type')
    const value = tag === undefined ? undefined : schema.nodes[tag.type]
    if (tag?.optional !== false || value?.kind !== 'literal' || value.value !== event) throw new Error(`${event}: event schema type does not match its root`)
    const operation = node.properties.find(property => property.name === 'surfaceOp')
    if (surface ? operation?.optional !== false : operation !== undefined) throw new Error(`${event}: surface metadata does not match its schema`)
  }
}

function subDigest(schema: CanonicalSchema, node: number): string {
  return schemaDigest(canonicalizeSchema(schema.nodes, node))
}

function matchingDiscriminants(before: CanonicalSchema, oldIndex: number, after: CanonicalSchema, newIndex: number): boolean {
  const oldNode = before.nodes[oldIndex]
  const newNode = after.nodes[newIndex]
  if (oldNode?.kind !== 'object' || newNode?.kind !== 'object') return false
  let shared = false
  for (const property of oldNode.properties) {
    const value = before.nodes[property.type]
    if (property.optional || value?.kind !== 'literal') continue
    const next = newNode.properties.find(item => item.name === property.name && !item.optional)
    const nextValue = next === undefined ? undefined : after.nodes[next.type]
    if (nextValue?.kind !== 'literal') continue
    if (value.value !== nextValue.value) return false
    shared = true
  }
  return shared
}

/** Classify structural differences; only optional payload properties and ordinary event additions are additive.
 * @param before - predecessor root, or absence for an addition.
 * @param after - successor root, or absence for deletion.
 * @returns concrete changes and their format-bump requirement.
 */
export function classifyPersistenceChange(before: PersistenceRoot | null, after: PersistenceRoot | null): PersistenceTypeChange[] {
  if (before === null) {
    return after === null ? [] : [{ path: after.key, description: 'root added',
      requiresVersionBump: after.kind !== 'event' || after.surface !== false }]
  }
  if (after === null) return [{ path: before.key, description: 'root removed', requiresVersionBump: true }]
  const key = after.key
  const oldRoot = before
  const newRoot = after
  const changes: PersistenceTypeChange[] = []
  const add = (path: string, description: string, requiresVersionBump = true): void => {
    changes.push({ path, description, requiresVersionBump })
  }
  if (before.kind !== after.kind || before.surface !== after.surface) add(key, 'root classification changed')
  if (before.digest === after.digest) return changes
  const seen = new Set<string>()
  const fingerprints = [new Map<number, string>(), new Map<number, string>()] as const
  const fingerprint = (schema: CanonicalSchema, index: number, side: 0 | 1): string => {
    let result = fingerprints[side].get(index)
    if (result === undefined) { result = subDigest(schema, index); fingerprints[side].set(index, result) }
    return result
  }
  function compare(oldIndex: number, newIndex: number, path: string, body: boolean): void {
    if (fingerprint(oldRoot.schema, oldIndex, 0) === fingerprint(newRoot.schema, newIndex, 1)) return
    const pair = `${oldIndex}:${newIndex}:${String(body)}`
    if (seen.has(pair)) return
    seen.add(pair)
    const oldNode = oldRoot.schema.nodes[oldIndex] as SchemaNode
    const newNode = newRoot.schema.nodes[newIndex] as SchemaNode
    if (oldNode.kind !== newNode.kind) { add(path, 'type changed'); return }
    if (oldNode.kind === 'object' && newNode.kind === 'object') {
      const oldProps = new Map(oldNode.properties.map(property => [property.name, property]))
      const newProps = new Map(newNode.properties.map(property => [property.name, property]))
      for (const [name, property] of oldProps) {
        const next = newProps.get(name)
        const child = `${path}.${name}`
        if (next === undefined) { add(child, 'property removed'); continue }
        if (property.optional !== next.optional) add(child, next.optional ? 'property made optional' : 'property made required', !body || !next.optional)
        compare(property.type, next.type, child, body || oldRoot.kind === 'event' && path === key && name === 'data')
      }
      for (const [name, property] of newProps) {
        if (!oldProps.has(name)) add(`${path}.${name}`, property.optional ? 'optional property added' : 'required property added', !body || !property.optional)
      }
      const oldIndices = new Map(oldNode.indices.map(entry => [subDigest(oldRoot.schema, entry.key), entry]))
      const newIndices = new Map(newNode.indices.map(entry => [subDigest(newRoot.schema, entry.key), entry]))
      if (oldIndices.size !== newIndices.size || [...oldIndices.keys()].some(index => !newIndices.has(index))) add(path, 'index signature changed')
      for (const [index, entry] of oldIndices) {
        const next = newIndices.get(index)
        if (next !== undefined) compare(entry.value, next.value, `${path}[*]`, body)
      }
      return
    }
    if (oldNode.kind === 'array' && newNode.kind === 'array') { compare(oldNode.element, newNode.element, `${path}[]`, body); return }
    if (oldNode.kind === 'tuple' && newNode.kind === 'tuple') {
      if (oldNode.elements.length !== newNode.elements.length) { add(path, 'tuple length changed'); return }
      for (const [index, element] of oldNode.elements.entries()) {
        const next = newNode.elements[index] as SchemaTupleElement
        if (element.optional !== next.optional || element.rest !== next.rest) add(`${path}[${index}]`, 'tuple element cardinality changed')
        compare(element.type, next.type, `${path}[${index}]`, body)
      }
      return
    }
    if (oldNode.kind === 'union' && newNode.kind === 'union') {
      const oldTypes = new Map(oldNode.types.map(index => [fingerprint(oldRoot.schema, index, 0), index]))
      const newTypes = new Map(newNode.types.map(index => [fingerprint(newRoot.schema, index, 1), index]))
      const removed = [...oldTypes].filter(([hash]) => !newTypes.has(hash)).map(([, index]) => index)
      const added = [...newTypes].filter(([hash]) => !oldTypes.has(hash)).map(([, index]) => index)
      if (removed.length === 1 && added.length === 1) compare(removed[0] as number, added[0] as number, path, body)
      else if (removed.length === added.length) {
        const paired = new Set<number>()
        const pairs: Array<[number, number]> = []
        for (const oldType of removed) {
          const candidates = added.filter(newType => matchingDiscriminants(oldRoot.schema, oldType, newRoot.schema, newType))
          if (candidates.length !== 1 || paired.has(candidates[0] as number)) { add(path, 'union variants changed'); return }
          paired.add(candidates[0] as number)
          pairs.push([oldType, candidates[0] as number])
        }
        for (const [oldType, newType] of pairs) compare(oldType, newType, path, body)
      } else add(path, 'union variants changed')
      return
    }
    add(path, 'type changed')
  }
  compare(0, 0, key, false)
  return changes
}

function parseDocument(source: string, filename: string): PersistenceChangeRecord {
  const frontmatter = /^---\n([\s\S]*?)\n---\n/u.exec(source)
  if (frontmatter === null || record(load(frontmatter[1] as string, { schema: JSON_SCHEMA }), filename).kind !== 'persistence-change') throw new Error(`${filename}: kind must be persistence-change`)
  const openings = [...source.matchAll(/^```yaml persistence-change\s*$/gmu)]
  const block = /^```yaml persistence-change[^\S\n]*\n([\s\S]*?)^```[^\S\n]*$/mu.exec(source)
  if (openings.length !== 1 || block === null) throw new Error(`${filename}: expected exactly one persistence-change block`)
  const input = record(load(block[1] as string, { schema: JSON_SCHEMA }), filename)
  keys(input, ['schemaVersion', 'id', 'baseline', 'changes'], filename)
  if (input.schemaVersion !== 1) throw new Error(`${filename}: unsupported acknowledgement schema version`)
  const id = identifier(input.id, filename)
  if (basename(filename) !== `${id}.md`) throw new Error(`${filename}: record id does not match filename`)
  bool(input.baseline, filename)
  const roots = new Set<string>()
  for (const value of array(input.changes, `${filename} changes`)) {
    const change = record(value, filename)
    keys(change, ['root', 'previous', 'after', 'decision'], filename)
    const root = textValue(change.root, 'changed root')
    if (roots.has(root)) throw new Error(`${filename}: duplicate change for ${root}`)
    roots.add(root)
    if (change.previous !== null) identifier(change.previous, 'previous record')
    if (change.after !== null) digest(change.after, 'after digest')
    if (change.decision !== 'same-version' && change.decision !== 'version-bump') throw new Error(`${filename}: invalid compatibility decision`)
  }
  if (roots.size === 0) throw new Error(`${filename}: changes must not be empty`)
  if (source.includes(EXPLANATION_PLACEHOLDER) || source.includes(EVIDENCE_PLACEHOLDER)) throw new Error(`${filename}: complete compatibility and verification prose`)
  return input as unknown as PersistenceChangeRecord
}

function headerVersion(root: PersistenceRoot | null): number | undefined {
  if (root === null) return undefined
  const node = root.schema.nodes[0]
  if (node?.kind !== 'object') return undefined
  const property = node.properties.find(item => item.name === 'version')
  if (property === undefined) return undefined
  const version = root.schema.nodes[property.type]
  return version?.kind === 'literal' && typeof version.value === 'number' && Number.isSafeInteger(version.value) ? version.value : undefined
}

/** Check every historical transition and return each root's unique current tip.
 * @param entries - parsed documents and their self-contained schema snapshots.
 * @returns validated history and tips, without consulting Git or current source.
 */
export function validatePersistenceHistory(entries: readonly PersistenceHistoryEntry[]): PersistenceHistory {
  if (entries.filter(entry => entry.record.baseline).length !== 1) throw new Error('persistence history requires exactly one baseline')
  const records = new Map<string, PersistenceHistoryEntry>()
  for (const entry of entries) {
    if (records.has(entry.record.id)) throw new Error(`duplicate persistence record ${entry.record.id}`)
    records.set(entry.record.id, entry)
    const expected = entry.record.changes.filter(change => change.after !== null).map(change => change.root).sort()
    if (JSON.stringify(expected) !== JSON.stringify(entry.snapshot.roots.map(root => root.key).sort())) throw new Error(`${entry.record.id}: snapshot roots do not match acknowledged after schemas`)
    for (const change of entry.record.changes) {
      const root = entry.snapshot.roots.find(root => root.key === change.root)
      if ((root?.digest ?? null) !== change.after) throw new Error(`${entry.record.id}: after digest mismatch for ${change.root}`)
      if (entry.record.baseline && (change.previous !== null || change.after === null || change.decision !== 'same-version')) throw new Error(`${entry.record.id}: invalid baseline transition`)
    }
  }
  const states = new Map<string, 'visiting' | 'visited'>()
  const successors = new Map<string, string>()
  const nodes = new Map<string, { entry: PersistenceHistoryEntry; change: PersistenceChange }>()
  const tips = new Map<string, Tip>()
  const nodeKey = (id: string | null, root: string): string => JSON.stringify([id, root])
  for (const entry of entries) for (const change of entry.record.changes) {
    const parentKey = nodeKey(change.previous, change.root)
    if (successors.has(parentKey)) throw new Error(`forked persistence history for ${change.root}: ${successors.get(parentKey)} and ${entry.record.id}`)
    successors.set(parentKey, entry.record.id)
    nodes.set(nodeKey(entry.record.id, change.root), { entry, change })
  }
  function visit(id: string, root: string): PersistenceRoot | null {
    const key = nodeKey(id, root)
    const found = nodes.get(key)
    if (found === undefined) throw new Error(`missing predecessor ${id} for ${root}`)
    if (states.get(key) === 'visiting') throw new Error(`cycle in persistence history for ${root}`)
    const after = found.entry.snapshot.roots.find(item => item.key === root) ?? null
    if (states.get(key) === 'visited') return after
    states.set(key, 'visiting')
    const before = found.change.previous === null ? null : visit(found.change.previous, root)
    if (!found.entry.record.baseline) {
      const differences = classifyPersistenceChange(before, after)
      if (differences.length === 0) throw new Error(`${id}: unchanged acknowledgement for ${root}`)
      if (differences.some(change => change.requiresVersionBump) && found.change.decision !== 'version-bump') throw new Error(`${id}: ${root} requires a format version bump (${differences.filter(change => change.requiresVersionBump).map(change => change.path + ': ' + change.description).join('; ')})`)
      if (found.change.decision === 'version-bump') {
        const header = found.entry.record.changes.find(change => change.root === 'SessionHeader')
        const oldHeader = header?.previous === null || header === undefined ? null : visit(header.previous, 'SessionHeader')
        const from = headerVersion(oldHeader)
        const to = headerVersion(found.entry.snapshot.roots.find(item => item.key === 'SessionHeader') ?? null)
        if (from === undefined || to === undefined || to <= from) throw new Error(`${id}: version-bump requires this record's own increasing SessionHeader.version transition`)
      }
    }
    states.set(key, 'visited')
    if (!successors.has(key)) tips.set(root, { id, root: after })
    return after
  }
  for (const entry of entries) for (const change of entry.record.changes) visit(entry.record.id, change.root)
  const baseline = entries.find(entry => entry.record.baseline) as PersistenceHistoryEntry
  if (!baseline.snapshot.roots.some(root => root.key === 'SessionHeader')
    || !baseline.snapshot.roots.some(root => root.key === 'SessionEventEnvelope')
    || !baseline.snapshot.roots.some(root => root.key === 'JsonlHeaderLine')) {
    throw new Error('baseline requires SessionHeader, JsonlHeaderLine, and SessionEventEnvelope roots')
  }
  return { entries, tips }
}

/** Read and validate all current-tree persistence acknowledgement files.
 * @param root - checkout or isolated fixture root.
 * @returns checked history without comparing its tips to current source.
 */
export function loadPersistenceHistory(root: string): PersistenceHistory {
  const directory = join(root, HISTORY_DIRECTORY)
  if (!existsSync(directory)) throw new Error('persistence history is missing; use pnpm run persistence-changes --baseline ID for explicit initialization')
  const files = readdirSync(directory).sort()
  const documents = files.filter(file => file.endsWith('.md') && !file.endsWith('.zh.md') && file !== 'README.md' && file !== 'AGENTS.md')
  const snapshots = new Set(files.filter(file => file.endsWith('.schema.json')))
  const entries = documents.map((filename) => {
    const source = readFileSync(join(directory, filename), 'utf8').replaceAll('\r\n', '\n')
    const change = parseDocument(source, filename)
    const snapshotName = `${change.id}.schema.json`
    if (!snapshots.delete(snapshotName)) throw new Error(`${filename}: missing schema snapshot ${snapshotName}`)
    const snapshot = parsePersistenceSnapshot(JSON.parse(readFileSync(join(directory, snapshotName), 'utf8')))
    const translatedName = `${change.id}.zh.md`
    if (!files.includes(translatedName)) throw new Error(`${filename}: missing Chinese counterpart`)
    const translated = readFileSync(join(directory, translatedName), 'utf8').replaceAll('\r\n', '\n')
    const englishBlock = source.match(/^```yaml persistence-change[^\S\n]*\n([\s\S]*?)^```[^\S\n]*$/mu)?.[1]
    const chineseBlocks = [...translated.matchAll(/^```yaml persistence-change[^\S\n]*\n([\s\S]*?)^```[^\S\n]*$/gmu)]
    if (chineseBlocks.length !== 1 || chineseBlocks[0]?.[1] !== englishBlock) throw new Error(`${filename}: bilingual machine records differ`)
    if (translated.includes(EXPLANATION_PLACEHOLDER) || translated.includes(EVIDENCE_PLACEHOLDER)) throw new Error(`${translatedName}: complete compatibility and verification prose`)
    return { record: change, snapshot }
  })
  if (snapshots.size !== 0) throw new Error(`unreferenced persistence schema snapshot: ${[...snapshots].join(', ')}`)
  return validatePersistenceHistory(entries)
}

function currentDifferences(history: PersistenceHistory, current: PersistenceSchemaInventory): string[] {
  const roots = new Map(current.roots.map(root => [root.key, root]))
  const differences: string[] = []
  for (const key of new Set([...history.tips.keys(), ...roots.keys()])) {
    if (classifyPersistenceChange(history.tips.get(key)?.root ?? null, roots.get(key) ?? null).length !== 0) differences.push(key)
  }
  return differences.sort()
}

/** Verify current generated output and acknowledgement tips together.
 * @param root - checkout or isolated fixture root.
 * @param current - freshly extracted current-source inventory.
 * @returns verified history.
 */
export function verifyPersistenceChanges(root: string, current: PersistenceSchemaInventory): PersistenceHistory {
  const committedPath = join(root, CURRENT_SCHEMA)
  if (!existsSync(committedPath)) throw new Error(`${CURRENT_SCHEMA} is missing; regenerate the persistence catalog`)
  const committed = parsePersistenceSnapshot(JSON.parse(readFileSync(committedPath, 'utf8')))
  if (JSON.stringify(committed) !== JSON.stringify(current)) throw new Error(`${CURRENT_SCHEMA} is stale; regenerate the persistence catalog`)
  const history = loadPersistenceHistory(root)
  const differences = currentDifferences(history, current)
  if (differences.length !== 0) {
    const details = differences.flatMap(key => classifyPersistenceChange(
      history.tips.get(key)?.root ?? null, current.roots.find(item => item.key === key) ?? null,
    ).map(change => `  ${change.path}: ${change.description} (${change.requiresVersionBump ? 'version-bump required' : 'same-version allowed'})`))
    throw new Error(`unacknowledged persistence type changes:\n${details.join('\n')}`)
  }
  return history
}

function machineBlock(change: PersistenceChangeRecord): string {
  return ['```yaml persistence-change', 'schemaVersion: 1', `id: ${change.id}`, `baseline: ${String(change.baseline)}`, 'changes:',
    ...change.changes.flatMap(item => [`  - root: ${JSON.stringify(item.root)}`, `    previous: ${item.previous === null ? 'null' : JSON.stringify(item.previous)}`, `    after: ${item.after === null ? 'null' : JSON.stringify(item.after)}`, `    decision: ${item.decision}`]), '```'].join('\n')
}

function scaffold(change: PersistenceChangeRecord, chinese: boolean): string {
  const summary = chinese ? '概述' : 'Summary'
  const compatibility = chinese ? '兼容性' : 'Compatibility'
  const verification = chinese ? '验证' : 'Verification'
  return ['---', `description: ${JSON.stringify(chinese ? '记录持久化类型更改及其兼容性确认。' : 'Records a persistence type transition and its compatibility acknowledgement.')}`, 'kind: persistence-change', '---', '',
    `# ${change.id}`, '', chinese ? `[English](${change.id}.md) | 中文` : `English | [中文](${change.id}.zh.md)`, '',
    `## ${summary}`, '', EXPLANATION_PLACEHOLDER, '', '## ' + (chinese ? '目录' : 'Table of Contents'), '',
    `- [${chinese ? '声明' : 'Declaration'}](#declaration)`, `- [${compatibility}](#compatibility)`, `- [${verification}](#verification)`, `- [${chinese ? '开发备注' : 'Dev Note'}](#dev-note)`, '',
    '<a id="declaration"></a>', `## ${chinese ? '声明' : 'Declaration'}`, '', machineBlock(change), '',
    '<a id="compatibility"></a>', `## ${compatibility}`, '', EXPLANATION_PLACEHOLDER, '',
    '<a id="verification"></a>', `## ${verification}`, '', EVIDENCE_PLACEHOLDER, '', '<a id="dev-note"></a>', `## ${chinese ? '开发备注' : 'Dev Note'}`, '', chinese ? '无。' : 'None.', ''].join('\n')
}

/** Execute the current-tree verifier or explicitly scaffold one acknowledgement.
 * @param args - check, baseline, or record command arguments.
 * @param root - checkout root; defaults to this script's repository.
 * @param extract - current-source extraction function; fixtures supply their own source reader.
 * @returns a concise operation result.
 */
export function runPersistenceChanges(
  args: readonly string[],
  root: string = resolve(import.meta.dirname, '..'),
  extract: (root: string) => PersistenceSchemaInventory = extractPersistenceSchema,
): string {
  const { values } = parseArgs({ args: [...args], strict: true, allowPositionals: false, options: {
    check: { type: 'boolean' }, baseline: { type: 'string' }, record: { type: 'string' }, decision: { type: 'string' }, root: { type: 'string' },
  } })
  if (values.root !== undefined) root = resolve(values.root)
  if ([values.check === true, values.baseline !== undefined, values.record !== undefined].filter(Boolean).length > 1) throw new Error('choose exactly one of --check, --baseline ID, or --record ID')
  if (values.record === undefined && values.decision !== undefined) throw new Error('--decision requires --record')
  const current = parsePersistenceSnapshot(extract(root))
  if (values.baseline === undefined && values.record === undefined) {
    const history = verifyPersistenceChanges(root, current)
    return `persistence changes: ${current.roots.length} roots match ${history.entries.length} history records.`
  }
  const baseline = values.baseline !== undefined
  const id = identifier(values.baseline ?? values.record, 'record id')
  const directory = join(root, HISTORY_DIRECTORY)
  if (baseline && existsSync(directory) && readdirSync(directory).some(file => file.endsWith('.schema.json') || ID_PATTERN.test(file.replace(/\.md$/u, '')))) throw new Error('persistence baseline already exists; baseline creation cannot reset history')
  const decision = baseline ? 'same-version' : values.decision
  if (decision !== 'same-version' && decision !== 'version-bump') throw new Error('--record requires --decision same-version|version-bump')
  const history = baseline ? undefined : loadPersistenceHistory(root)
  const changed = baseline ? current.roots.map(root => root.key) : currentDifferences(history as PersistenceHistory, current)
  if (changed.length === 0) throw new Error('no persistence type changes to acknowledge')
  const roots = current.roots.filter(root => changed.includes(root.key))
  const change: PersistenceChangeRecord = { schemaVersion: 1, id, baseline, changes: changed.sort().map(key => ({
    root: key, previous: history?.tips.get(key)?.id ?? null,
    after: roots.find(root => root.key === key)?.digest ?? null, decision,
  })) }
  const snapshot: PersistenceSchemaInventory = { formatVersion: 1, roots, types: [] }
  validatePersistenceHistory([...(history?.entries ?? []), { record: change, snapshot }])
  const outputs = [
    [`${id}.md`, scaffold(change, false)],
    [`${id}.zh.md`, scaffold(change, true)],
    [`${id}.schema.json`, JSON.stringify(snapshot, null, 2) + '\n'],
  ] as const
  if (outputs.some(([file]) => existsSync(join(directory, file)))) throw new Error(`${id}: acknowledgement file already exists`)
  mkdirSync(directory, { recursive: true })
  for (const [file, content] of outputs) writeFileSync(join(directory, file), content, { flag: 'wx' })
  return `Created ${HISTORY_DIRECTORY}/${id}.md and paired schema files. Complete the compatibility and verification prose, then record translation pairing.`
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  try {
    console.log(runPersistenceChanges(process.argv.slice(2)))
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
