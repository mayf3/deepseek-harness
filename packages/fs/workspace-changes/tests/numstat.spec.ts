/** Numstat parsing and hunk line counting. */
import { describe, expect, it } from 'vitest'
import { fileDiffsOf, hunkLineCounts, parseNumstat } from '../src/numstat.ts'

describe('parseNumstat', () => {
  it('reads plain, binary, and rename records', () => {
    const output = ['3\t1\tsrc/a.ts', '-\t-\timg.png', '2\t0\t', 'old.txt', 'new.txt', ''].join('\u0000')
    expect(parseNumstat(output)).toEqual([
      { path: 'src/a.ts', added: 3, deleted: 1, binary: false },
      { path: 'img.png', added: 0, deleted: 0, binary: true },
      { path: 'new.txt', added: 2, deleted: 0, binary: false },
    ])
  })

  it('returns nothing for empty output', () => {
    expect(parseNumstat('')).toEqual([])
  })

  it('rejects output without a final terminator or with malformed records', () => {
    expect(() => parseNumstat('1\t1\ta.txt')).toThrow('NUL-terminated')
    expect(() => parseNumstat('garbage\0')).toThrow('malformed numstat record')
    expect(() => parseNumstat('1\t0\t\0old.txt\0')).toThrow('rename')
  })
})

describe('hunkLineCounts', () => {
  it('counts changed lines and ignores context', () => {
    expect(hunkLineCounts([
      { path: 'a', oldText: 'keep\nold\nkeep', newText: 'keep\nnew\nnew2\nkeep' },
      { path: 'a', oldText: null, newText: 'x\ny\n' },
    ])).toEqual({ added: 4, deleted: 1 })
  })
})

describe('fileDiffsOf', () => {
  it('narrows the file-tool metadata and rejects anything else', () => {
    expect(fileDiffsOf({ diffs: [{ path: 'a', oldText: null, newText: 'b' }] })).toEqual([{ path: 'a', oldText: null, newText: 'b' }])
    expect(fileDiffsOf(undefined)).toBeUndefined()
    expect(fileDiffsOf([])).toBeUndefined()
    expect(fileDiffsOf({ diffs: [] })).toBeUndefined()
    expect(fileDiffsOf({ diffs: [null] })).toBeUndefined()
    expect(fileDiffsOf({ diffs: [{ path: 1, oldText: null, newText: '' }] })).toBeUndefined()
    expect(fileDiffsOf({ diffs: [{ path: 'a', oldText: 2, newText: '' }] })).toBeUndefined()
    expect(fileDiffsOf({ diffs: [{ path: 'a', oldText: 'x', newText: 3 }] })).toBeUndefined()
  })
})
