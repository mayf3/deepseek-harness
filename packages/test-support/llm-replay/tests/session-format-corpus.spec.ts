import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionFormatUnsupportedMigrationError } from '@deepseek-ai/dsh-session-format-catalog'
import { parseSessionLog } from '../src/index.ts'
import { ALPHA_SESSION_FORMAT_REFUSAL_FIXTURES } from '../src/alpha-refusal-fixtures.ts'

const repoRoot = resolve(import.meta.dirname, '../../../..')
const excludedDirectories = new Set(['dist', 'lib', 'node_modules'])

const alphaRefusalManifest: ReadonlyMap<string, string> = new Map(
  ALPHA_SESSION_FORMAT_REFUSAL_FIXTURES.map(fixture => [fixture.repoRelativePath, fixture.expectedMessage]),
)

function committedSessionFixtures(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name)) files.push(...committedSessionFixtures(path))
    } else if (entry.name.startsWith('session') && entry.name.endsWith('.jsonl')) {
      if (!/^session(?:\.[1-9]\d*)?(?:\.v[1-9]\d*)?\.jsonl$/.test(entry.name)) {
        throw new Error(`invalid committed Session filename: ${path}`)
      }
      files.push(path)
    }
  }
  return files
}

function declaresFormat(text: string): boolean {
  const firstLine = text.split(/\r?\n/).find(line => line.trim().length > 0)
  if (firstLine === undefined) return false
  const header = JSON.parse(firstLine) as unknown
  return header !== null && typeof header === 'object' && !Array.isArray(header)
    && Object.hasOwn(header, 'version')
}

function filenameFormatVersion(path: string): number {
  const match = /^session(?:\.[1-9]\d*)?(?:\.v([1-9]\d*))?\.jsonl$/.exec(path.split(/[/\\]/u).at(-1) ?? '')
  if (match === null) throw new Error(`invalid committed Session filename: ${path}`)
  return match[1] === undefined ? 0 : Number(match[1])
}

describe('committed Session format corpus', () => {
  it('migrates every versioned fixture or matches one exact alpha refusal', () => {
    const seenRefusals = new Set<string>()
    const files = ['snapshots', 'packages', 'scripts/snapshots/python-sdk-single-exe']
      .flatMap(root => committedSessionFixtures(join(repoRoot, root)))
      .sort()

    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      if (!declaresFormat(source)) continue
      const key = relative(repoRoot, file).split('\\').join('/')
      const header = JSON.parse(source.split(/\r?\n/u).find(line => line.trim().length > 0) ?? '{}') as {
        version?: unknown
      }
      expect(header.version, `${key}: filename/header Session generation`).toBe(filenameFormatVersion(file))
      let failure: unknown
      try {
        parseSessionLog(source)
      } catch (error: unknown) {
        failure = error
      }
      const expected = alphaRefusalManifest.get(key)
      if (expected === undefined) {
        expect(failure, `${key}: unclassified Session format refusal`).toBeUndefined()
      } else {
        expect(failure, `${key}: refusal no longer occurs`)
          .toBeInstanceOf(SessionFormatUnsupportedMigrationError)
        expect((failure as Error).message).toBe(expected)
        seenRefusals.add(key)
      }
    }

    expect([...seenRefusals].sort()).toEqual([...alphaRefusalManifest.keys()].sort())
  })
})
