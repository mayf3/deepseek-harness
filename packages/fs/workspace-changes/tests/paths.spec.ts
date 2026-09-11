/** Display, durable, and temporary path rules. */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compareDisplay, displayPathOf, durablePathOf, isTemporaryPath, temporaryRoots } from '../src/paths.ts'

const cwd = '/home/u/proj/pkg'
const root = '/home/u/proj'
const home = '/home/u'

describe('displayPathOf', () => {
  it('prefers cwd-relative, then repository-relative, then home, then absolute', () => {
    expect(displayPathOf('/home/u/proj/pkg/src/a.ts', cwd, root, home)).toBe('src/a.ts')
    expect(displayPathOf('/home/u/proj/other/b.ts', cwd, root, home)).toBe('../other/b.ts')
    expect(displayPathOf('/home/u/.zshrc', cwd, root, home)).toBe('~/.zshrc')
    expect(displayPathOf('/etc/hosts', cwd, root, home)).toBe('/etc/hosts')
    expect(displayPathOf('/home/u/.zshrc', cwd, root, '')).toBe('/home/u/.zshrc')
  })
})

describe('durablePathOf', () => {
  it('keeps cwd-relative paths relative and everything else absolute', () => {
    expect(durablePathOf('/home/u/proj/pkg/a.ts', cwd)).toBe('a.ts')
    expect(durablePathOf('/home/u/proj/b.ts', cwd)).toBe('/home/u/proj/b.ts')
  })
})

describe('temporary paths', () => {
  it('matches the platform temp roots in raw and canonical form and skips missing candidates', () => {
    const roots = temporaryRoots()
    expect(roots).toContain('/tmp')
    expect(isTemporaryPath(join(tmpdir(), 'scratch.txt'), roots)).toBe(true)
    expect(isTemporaryPath('/tmp/x', roots)).toBe(true)
    expect(isTemporaryPath('/tmpfoo/x', roots)).toBe(false)
    expect(isTemporaryPath('/home/u/x', roots)).toBe(false)
    expect(temporaryRoots(['/definitely/missing/root'])).toEqual(['/definitely/missing/root'])
  })
})

describe('compareDisplay', () => {
  it('orders by code units so parent and absolute paths lead', () => {
    const sorted = [{ display: 'src/b' }, { display: '~/x' }, { display: '../a' }, { display: '/etc/h' }, { display: 'src/a' }].sort(compareDisplay)
    expect(sorted.map(file => file.display)).toEqual(['../a', '/etc/h', 'src/a', 'src/b', '~/x'])
    expect(compareDisplay({ display: 'a' }, { display: 'a' })).toBe(0)
  })
})
