import { describe, expect, it } from 'vitest'
import { findConcreteTermViolations } from './verify-concrete-terms.ts'

const blockedTerm = 'prove' + 'nance'

describe('concrete terminology policy', () => {
  it('rejects case variants in paths, prose, and identifiers', () => {
    expect(findConcreteTermViolations(`docs/${blockedTerm}-notes.md`, [
      'origin metadata',
      blockedTerm.toUpperCase(),
      `Assistant${blockedTerm[0]?.toUpperCase()}${blockedTerm.slice(1)}`,
    ].join('\n'))).toEqual([
      { file: `docs/${blockedTerm}-notes.md`, line: null },
      { file: `docs/${blockedTerm}-notes.md`, line: 2 },
      { file: `docs/${blockedTerm}-notes.md`, line: 3 },
    ])
  })

  it('scans text that contains an embedded NUL', () => {
    expect(findConcreteTermViolations('packages/example/src/source.ts', `scope\0${blockedTerm}`))
      .toEqual([{ file: 'packages/example/src/source.ts', line: 1 }])
  })

  it('accepts exact replacement terms', () => {
    expect(findConcreteTermViolations(
      'packages/example/src/origin.ts',
      'provider metadata; source-event references; artifact identity; browser-zone evidence',
    )).toEqual([])
  })

  it('excludes vendored sources and frozen Agent Notes', () => {
    expect(findConcreteTermViolations(`vendor/example/${blockedTerm}.ts`, blockedTerm)).toEqual([])
    expect(findConcreteTermViolations(
      `.agents/notes/archived/process/${blockedTerm}.md`,
      blockedTerm,
    )).toEqual([])
    expect(findConcreteTermViolations(
      '.agents/notes/implemented/process/current.md',
      blockedTerm,
    )).toEqual([{ file: '.agents/notes/implemented/process/current.md', line: 1 }])
  })
})
