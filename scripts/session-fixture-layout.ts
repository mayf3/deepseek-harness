/** Canonical packed-row and envelope projection helpers for repository session fixtures. */

import { deepStrictEqual } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  decodeSeqRanges,
  decodeStorageRecord,
  packChunkRuns,
  SessionLogOffset,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'
import type { SessionLogOffset as SessionLogOffsetType } from '@deepseek-ai/dsh-session'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'

/** Physical persistence artifacts validated by the WebWorker runtime fixture spec. */
const WEBWORKER_PHYSICAL_SESSION_FIXTURE_ROOT =
  'packages/experimental/webworker-runtime/tests/fixtures/vfs-example/home/sessions/'

/** Installed-runtime snapshots that preserve the JSONL writer's physical encoding. */
const PYTHON_RUNTIME_PHYSICAL_SESSION_FIXTURE_ROOT =
  'scripts/snapshots/python-sdk-single-exe/'

/** One repository session fixture and its canonical projected representation. */
export interface SessionFixtureLayout {
  /** Repository-relative path with `/` separators. */
  path: string
  /** Current fixture bytes decoded as UTF-8. */
  source: string
  /** Canonical projected fixture bytes. */
  canonical: string
}

/**
 * Whether a repository JSONL preserves physical persistence encoding rather
 * than the logical event projection owned by this script.
 * @param path - Repository-relative path with `/` separators.
 * @returns True for physical WebWorker and installed-runtime session logs.
 */
export function isPhysicalSessionFixture(path: string): boolean {
  if (path.startsWith(WEBWORKER_PHYSICAL_SESSION_FIXTURE_ROOT)) {
    return /\/session(?:\.v[1-9]\d*)?\.jsonl$/.test(path)
  }
  return path.startsWith(PYTHON_RUNTIME_PHYSICAL_SESSION_FIXTURE_ROOT)
    && /\/session(?:\.[1-9]\d*)?(?:\.v[1-9]\d*)?\.jsonl$/.test(path)
}

function isSessionHeader(value: unknown): boolean {
  return value !== null && typeof value === 'object' && (value as { type?: unknown }).type === 'session'
}

function validationHeader(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const header = { ...value as Record<string, unknown> }
  if (header.version === 0 && !Object.hasOwn(header, 'delegationDepth')) header.delegationDepth = 0
  if (typeof header.cwd === 'string' && /^\{\{cwd\}\}(?:\/|$)/.test(header.cwd)) {
    header.cwd = header.cwd.replace('{{cwd}}', '/dsh-snapshot-cwd')
  }
  return header
}

function renderFixture(headerLine: string, events: readonly SessionEvent[]): string {
  return [
    headerLine,
    ...packChunkRuns(events).map((stored) => {
      const record = { ...stored } as unknown as Record<string, unknown>
      delete record.seq
      delete record.time
      delete record.seq0
      delete record.time0
      return JSON.stringify(record)
    }),
    '',
  ].join('\n')
}

function projectedRowCardinality(record: Readonly<Record<string, unknown>>): number {
  const data = record.data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return 1
  const key = record.type === 'tool-call-chunks' ? 'args' : 'texts'
  const values = (data as Record<string, unknown>)[key]
  return Array.isArray(values) && values.length > 0 ? values.length : 1
}

function parseFixtureObjectLine(line: string, lineNumber: number): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(line) as unknown
  } catch (error) {
    throw new Error(`session snapshot line ${lineNumber} contains invalid JSON`, { cause: error })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`session snapshot line ${lineNumber} must be a JSON object`)
  }
  return value as Record<string, unknown>
}

function parseFixtureRows(content: string, headerValue: unknown): SessionEvent[] {
  const rows: Record<string, unknown>[] = []
  const rowLines: number[] = []
  let nextSeq: SessionLogOffsetType = SessionLogOffset(0)
  let headerSkipped = false
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (line.trim().length === 0) continue
    if (!headerSkipped) {
      headerSkipped = true
      continue
    }
    const record = parseFixtureObjectLine(line, index + 1)
    const packed = record.type === 'text-chunks'
      || record.type === 'reasoning-chunks'
      || record.type === 'tool-call-chunks'
    const seqKey = packed ? 'seq0' : 'seq'
    const timeKey = packed ? 'time0' : 'time'
    if (!Object.hasOwn(record, seqKey)) record[seqKey] = nextSeq
    if (!Object.hasOwn(record, timeKey)) record[timeKey] = 0
    rows.push(record)
    rowLines.push(index + 1)
    nextSeq = SessionLogOffset(nextSeq + projectedRowCardinality(record))
  }
  // Versionless protocol fixtures are outside the released format catalog;
  // they exercise only the current storage-row projection.
  if (headerValue === null || typeof headerValue !== 'object' || Array.isArray(headerValue)
    || !Object.hasOwn(headerValue, 'version')) {
    return rows.flatMap((source, index) => {
      const record = { ...source }
      try {
        if (Object.hasOwn(record, 'sourceEventSeqs')) {
          record.sourceEventSeqs = decodeSeqRanges(record.sourceEventSeqs)
        }
        return decodeStorageRecord(record)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`session snapshot line ${rowLines[index] ?? 1}: ${detail}`, { cause: error })
      }
    })
  }
  try {
    return [
      ...sessionFormatCatalog.decodeArtifact(validationHeader(headerValue), rows).events,
    ] as unknown as SessionEvent[]
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const storedRow = /\brow (\d+)\b/.exec(detail)
    const line = storedRow === null ? 1 : rowLines[Number(storedRow[1])] ?? 1
    throw new Error(`session snapshot line ${line}: ${detail}`, { cause: error })
  }
}

function withoutEnvelope(events: readonly SessionEvent[]): Array<Omit<SessionEvent, 'seq' | 'time'>> {
  return events.map((event) => {
    const { seq: _seq, time: _time, ...projected } = event
    return projected
  })
}

/**
 * Canonicalize one JSONL document when its first record is a session header.
 * The header line remains byte-identical; body records decode to logical events,
 * re-encode with {@link packChunkRuns}, and omit storage sequence/time envelopes.
 * Non-session JSONL returns undefined.
 *
 * @param content - JSONL source text.
 * @param label - path-like diagnostic label.
 * @returns Canonical text for a session fixture, otherwise undefined.
 */
export function canonicalSessionFixture(content: string, label = '<session-fixture>'): string | undefined {
  const headerLine = content.split(/\r?\n/).find(line => line.trim().length > 0)
  if (headerLine === undefined) return undefined

  let headerValue: unknown
  try {
    headerValue = JSON.parse(headerLine) as unknown
  } catch {
    return undefined
  }
  if (!isSessionHeader(headerValue)) return undefined

  let events
  try {
    events = parseFixtureRows(content, headerValue)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${label}: ${detail}`, { cause: error })
  }
  const canonical = renderFixture(headerLine, events)
  const decoded = parseFixtureRows(canonical, headerValue)
  try {
    deepStrictEqual(withoutEnvelope(decoded), withoutEnvelope(events))
  } catch (error) {
    throw new Error(`${label}: packed snapshot rewrite changed the event payload stream`, { cause: error })
  }
  if (renderFixture(headerLine, decoded) !== canonical) {
    throw new Error(`${label}: packed rewrite is not idempotent`)
  }
  return canonical
}

/**
 * Discover tracked and unignored untracked JSONL files through Git.
 *
 * @param root - repository root.
 * @returns Stable repository-relative paths.
 */
function discoverJsonlFiles(root: string): string[] {
  return execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.jsonl'],
    { cwd: root, encoding: 'utf8' },
  ).split('\0')
    .filter(path => path.length > 0 && existsSync(resolve(root, path)))
    .sort()
}

/**
 * Inspect every repository JSONL whose first record is a session header.
 *
 * @param root - repository root.
 * @returns Session fixtures with current and canonical text.
 */
export function inspectSessionFixtureLayouts(root: string): SessionFixtureLayout[] {
  return discoverJsonlFiles(root).flatMap((path) => {
    if (isPhysicalSessionFixture(path)) return []
    const source = readFileSync(resolve(root, path), 'utf8')
    const canonical = canonicalSessionFixture(source, path)
    return canonical === undefined ? [] : [{ path, source, canonical }]
  })
}
