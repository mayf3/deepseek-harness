/** Numstat parsing and hunk line counting. */
import { describe, expect, it } from 'vitest'
import { argumentHunks, fileDiffsOf, hunkLineCounts, parseNumstat } from '../src/numstat.ts'

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

describe('argumentHunks', () => {
  const call = (name: string, args: unknown) => argumentHunks(name, JSON.stringify(args))

  it('derives hunks from write, edit, and editor mutations', () => {
    expect(call('write', { file_path: 'a.txt', content: 'x\n' })).toEqual([{ path: 'a.txt', oldText: null, newText: 'x\n' }])
    expect(call('edit', { file_path: 'a.txt', old_string: 'x', new_string: 'y' })).toEqual([{ path: 'a.txt', oldText: 'x', newText: 'y' }])
    expect(call('str_replace_editor', { command: 'create', path: 'b.txt', file_text: 'b' })).toEqual([{ path: 'b.txt', oldText: null, newText: 'b' }])
    expect(call('str_replace_editor', { command: 'str_replace', path: 'b.txt', old_str: 'b' })).toEqual([{ path: 'b.txt', oldText: 'b', newText: '' }])
    expect(call('str_replace_editor', { command: 'str_replace', path: 'b.txt', old_str: 'b', new_str: 'c' })).toEqual([{ path: 'b.txt', oldText: 'b', newText: 'c' }])
    expect(call('str_replace_editor', { command: 'insert', path: 'b.txt', insert_line: 1, new_str: 'i' })).toEqual([{ path: 'b.txt', oldText: null, newText: 'i' }])
  })

  it('yields null for reads, unknown tools, and malformed arguments', () => {
    expect(argumentHunks('write', '{')).toBeNull()
    expect(argumentHunks('write', '[]')).toBeNull()
    expect(call('read', { file_path: 'a.txt' })).toBeNull()
    expect(call('write', { file_path: ' ', content: 'x' })).toBeNull()
    expect(call('write', { file_path: 'a.txt' })).toBeNull()
    expect(call('edit', { file_path: 'a.txt', old_string: '', new_string: 'y' })).toBeNull()
    expect(call('str_replace_editor', { command: 'view', path: 'b.txt' })).toBeNull()
    expect(call('str_replace_editor', { command: 'create', path: '' })).toBeNull()
    expect(call('str_replace_editor', { command: 'create', path: 'b.txt' })).toBeNull()
    expect(call('str_replace_editor', { command: 'str_replace', path: 'b.txt', old_str: 'b', new_str: 1 })).toBeNull()
    expect(call('str_replace_editor', { command: 'insert', path: 'b.txt', insert_line: 1 })).toBeNull()
  })
})
