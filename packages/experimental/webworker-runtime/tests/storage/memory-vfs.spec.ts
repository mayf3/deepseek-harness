/**
 * The identity, timestamp, link, mutation, and durability-sink guarantees
 * MemoryVfs owes its consumers, asserted directly rather than through the
 * `node:fs` bridge.
 *
 * `dsh-fs-local` builds a version token from `dev:ino:size:mtimeNs:ctimeNs` and
 * refuses a write whose token moved since it read. Two properties carry that:
 * `ino` identifies the entry at a path, and `mtimeMs` moves on every write. The
 * timestamp cases freeze the clock, because these writes are in memory and two
 * revisions routinely land in the same millisecond — a real-clock test passes
 * whether or not the strict increment exists.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVfs } from '../../src/storage/memory.ts'
import type { VfsBigIntStats, VfsMutation, VfsMutationSink, VfsStats } from '../../src/storage/types.ts'

const identity = (vfs: MemoryVfs, path: string): bigint =>
  (vfs.statSync(path, { bigint: true }) as VfsBigIntStats).ino

const modified = (vfs: MemoryVfs, path: string): number => (vfs.statSync(path) as VfsStats).mtimeMs

afterEach(() => { vi.restoreAllMocks() })

describe('entry identity', () => {
  it('distinguishes paths and holds each identity across repeated stats', () => {
    const vfs = new MemoryVfs()
    vfs.seed('/dsh/one.txt', 'one')
    vfs.seed('/dsh/two.txt', 'two')
    const first = identity(vfs, '/dsh/one.txt')
    expect(identity(vfs, '/dsh/two.txt')).not.toBe(first)
    expect(identity(vfs, '/dsh/one.txt')).toBe(first)
  })

  it('forgets the identities under a directory removed as a subtree', () => {
    const vfs = new MemoryVfs()
    vfs.seed('/dsh/skills/git/SKILL.md', '# git\n')
    const before = identity(vfs, '/dsh/skills/git/SKILL.md')
    vfs.rmSync('/dsh/skills', { recursive: true })
    vfs.seed('/dsh/skills/git/SKILL.md', '# git rebuilt\n')
    expect(identity(vfs, '/dsh/skills/git/SKILL.md')).not.toBe(before)
  })

  it('assigns the destination of a rename an identity of its own', () => {
    // Identity belongs to the path, not to the bytes: a renamed-over path must
    // stop looking like the entry it replaced, which is the property the guard
    // reads. The source identity deliberately does not follow the move.
    const vfs = new MemoryVfs()
    vfs.seed('/dsh/from.txt', 'moved')
    vfs.seed('/dsh/to.txt', 'replaced')
    const [source, destination] = [identity(vfs, '/dsh/from.txt'), identity(vfs, '/dsh/to.txt')]
    vfs.renameSync('/dsh/from.txt', '/dsh/to.txt')
    const renamed = identity(vfs, '/dsh/to.txt')
    expect(vfs.readFileSync('/dsh/to.txt', 'utf8')).toBe('moved')
    expect([renamed === source, renamed === destination]).toEqual([false, false])
  })
})

describe('modification time', () => {
  it('hydrates explicit metadata without confusing timestamps with permission bits', () => {
    const vfs = new MemoryVfs()
    vfs.seed('/dsh/restored', 'value', { mode: 0o600, mtimeMs: 1_600_000_000_000 })
    vfs.seedDirectory('/dsh/restored-directory', { mode: 0o700, mtimeMs: 1_600_000_000_001 })
    const stats = vfs.statSync('/dsh/restored') as VfsStats
    const directory = vfs.statSync('/dsh/restored-directory') as VfsStats
    expect([stats.mode & 0o777, stats.mtimeMs]).toEqual([0o600, 1_600_000_000_000])
    expect([directory.mode & 0o777, directory.mtimeMs]).toEqual([0o700, 1_600_000_000_001])
  })

  it('advances on every write even while the clock stands still', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    const vfs = new MemoryVfs()
    vfs.seed('/dsh/log.jsonl', 'first\n')
    const seeded = modified(vfs, '/dsh/log.jsonl')
    vfs.writeFileSync('/dsh/log.jsonl', 'second\n')
    const written = modified(vfs, '/dsh/log.jsonl')
    vfs.appendFileSync('/dsh/log.jsonl', 'third\n')
    const appended = modified(vfs, '/dsh/log.jsonl')
    vfs.truncateSync('/dsh/log.jsonl', 6)
    const truncated = modified(vfs, '/dsh/log.jsonl')
    expect([written > seeded, appended > written, truncated > appended]).toEqual([true, true, true])
    // One millisecond per revision: the increment is the minimum that separates
    // two tokens, not a coarser bump that would skew a real timestamp.
    expect(truncated - seeded).toBe(3)
  })

  it('takes the clock once the clock has passed the entry', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    const vfs = new MemoryVfs()
    vfs.seed('/dsh/log.jsonl', 'first\n')
    clock.mockReturnValue(1_700_000_005_000)
    vfs.writeFileSync('/dsh/log.jsonl', 'second\n')
    expect(modified(vfs, '/dsh/log.jsonl')).toBe(1_700_000_005_000)
  })

  it('advances a directory only when its immediate entry set changes', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    const vfs = new MemoryVfs()
    vfs.seedDirectory('/dsh/workspace')
    const empty = modified(vfs, '/dsh/workspace')
    vfs.writeFileSync('/dsh/workspace/file.txt', 'one')
    const created = modified(vfs, '/dsh/workspace')
    vfs.writeFileSync('/dsh/workspace/file.txt', 'two')
    const rewritten = modified(vfs, '/dsh/workspace')
    vfs.rmSync('/dsh/workspace/file.txt')
    const removed = modified(vfs, '/dsh/workspace')
    expect([created > empty, rewritten === created, removed > rewritten]).toEqual([true, true, true])
  })
})

describe('mutation publication', () => {
  it('publishes only committed runtime changes and keeps image seeding silent', () => {
    const vfs = new MemoryVfs()
    const mutations: VfsMutation[] = []
    vfs.subscribe((mutation) => { mutations.push(mutation) })
    vfs.seed('/dsh/seeded.txt', 'seeded')
    expect(mutations).toEqual([])
    vfs.writeFileSync('/dsh/seeded.txt', 'changed')
    vfs.mkdirSync('/dsh/created')
    vfs.chmodSync('/dsh/created', 0o700)
    vfs.renameSync('/dsh/seeded.txt', '/dsh/renamed.txt')
    vfs.rmSync('/dsh/created', { recursive: true })
    expect(mutations.map(mutation => ({
      kind: mutation.kind,
      path: mutation.path,
      ...mutation.kind === 'write' ? { entryChanged: mutation.entryChanged } : {},
      ...mutation.kind === 'chmod' ? { mode: mutation.mode } : {},
    }))).toEqual([
      { kind: 'write', path: '/dsh/seeded.txt', entryChanged: false },
      { kind: 'mkdir', path: '/dsh/created' },
      { kind: 'chmod', path: '/dsh/created', mode: 0o700 },
      { kind: 'remove', path: '/dsh/seeded.txt' },
      { kind: 'write', path: '/dsh/renamed.txt', entryChanged: true },
      { kind: 'remove', path: '/dsh/created' },
    ])
    const renamed = mutations[4]
    expect(renamed?.kind === 'write' && new TextDecoder().decode(renamed.bytes)).toBe('changed')
    expect(() => { vfs.writeFileSync('/missing/file', 'no') }).toThrow(/ENOENT/)
    expect(mutations).toHaveLength(6)
  })

  it('contains a faulty observer and lets disposal stop later notifications', () => {
    const vfs = new MemoryVfs()
    vfs.seedDirectory('/dsh')
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    const first = vfs.subscribe(() => { throw new Error('observer failed') })
    const seen: string[] = []
    const second = vfs.subscribe((mutation) => { seen.push(mutation.path) })
    vfs.writeFileSync('/dsh/one', '1')
    first()
    second()
    vfs.writeFileSync('/dsh/two', '2')
    expect(seen).toEqual(['/dsh/one'])
    expect(reported).toHaveBeenCalledOnce()
  })

  it('feeds the same complete mutations to a durable sink and live subscribers', async () => {
    const recorded: VfsMutation[] = []
    let flushes = 0
    const sink: VfsMutationSink = {
      record: (mutation) => { recorded.push(mutation) },
      flush: async () => { flushes += 1 },
    }
    const vfs = new MemoryVfs({ sink })
    vfs.seedDirectory('/dsh')
    const observed: VfsMutation[] = []
    vfs.subscribe((mutation) => { observed.push(mutation) })
    vfs.writeFileSync('/dsh/log', 'a')
    vfs.appendFileSync('/dsh/log', 'bc')
    await vfs.flush()
    expect(observed).toEqual(recorded)
    expect(observed[0]).toBe(recorded[0])
    expect(recorded[0]).toMatchObject({ kind: 'write', path: '/dsh/log', mode: 0o644, entryChanged: true })
    expect(recorded[1]).toMatchObject({ kind: 'write', path: '/dsh/log', mode: 0o644, entryChanged: false, appendedFrom: 1 })
    expect(recorded[1]?.kind === 'write' && new TextDecoder().decode(recorded[1].bytes)).toBe('abc')
    expect(flushes).toBe(1)
  })

  it('decomposes a directory rename into replayable destination state', () => {
    const recorded: VfsMutation[] = []
    const vfs = new MemoryVfs({
      sink: { record: (mutation) => { recorded.push(mutation) }, flush: () => Promise.resolve() },
    })
    vfs.seedDirectory('/dsh/staging/nested', { mode: 0o700 })
    vfs.seed('/dsh/staging/nested/file', 'value', { mode: 0o600 })
    vfs.renameSync('/dsh/staging', '/dsh/published')

    expect(recorded.map(mutation => [mutation.kind, mutation.path])).toEqual([
      ['remove', '/dsh/staging'],
      ['mkdir', '/dsh/published'],
      ['mkdir', '/dsh/published/nested'],
      ['write', '/dsh/published/nested/file'],
    ])
    expect(recorded[3]).toMatchObject({ kind: 'write', mode: 0o600, entryChanged: true })
    expect(recorded[3]?.kind === 'write' && new TextDecoder().decode(recorded[3].bytes)).toBe('value')
  })
})

describe('hard links', () => {
  it('shares the bytes present at link time and diverges on the next write', () => {
    const vfs = new MemoryVfs()
    vfs.seed('/dsh/session.jsonl', 'committed\n')
    vfs.linkSync('/dsh/session.jsonl', '/dsh/session-latest.jsonl')
    expect(vfs.readFileSync('/dsh/session-latest.jsonl', 'utf8')).toBe('committed\n')
    vfs.appendFileSync('/dsh/session.jsonl', 'appended\n')
    expect(vfs.readFileSync('/dsh/session.jsonl', 'utf8')).toBe('committed\nappended\n')
    expect(vfs.readFileSync('/dsh/session-latest.jsonl', 'utf8')).toBe('committed\n')
  })
})
