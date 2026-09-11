/** The plugin records each top-level turn's file changes from real git snapshots. */
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as WorkspaceChanges from '../src/index.ts'
import { changes, endTurn, git, scratchDir, settle, startTurn, toolCall } from './support.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
  vi.restoreAllMocks()
})

async function boot(config: Partial<WorkspaceChanges.Config> = {}) {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(LocalSubprocessRuntime)
  const fiber = await ctx.plugin(WorkspaceChanges, config as WorkspaceChanges.Config)
  return { ctx, fiber }
}

async function repository(): Promise<string> {
  const cwd = await scratchDir('dsh-workspace-changes-repo-', cleanups)
  git(cwd, 'init', '-q', '-b', 'main')
  await writeFile(join(cwd, 'a.txt'), 'l1\nl2\nl3\n')
  await writeFile(join(cwd, 'b.txt'), 'x\n')
  await writeFile(join(cwd, 'same.txt'), 'same\n')
  await writeFile(join(cwd, '.gitignore'), '.env*\n')
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-q', '-m', 'init')
  return cwd
}

describe('workspace-changes in a repository', () => {
  it('records the turn’s own changes and excludes the user’s prior uncommitted work', async () => {
    const cwd = await repository()
    await writeFile(join(cwd, 'b.txt'), 'x user\n')
    await writeFile(join(cwd, 'u.txt'), 'user untracked\n')
    const { ctx } = await boot()
    const session = ctx.sessions.create(SessionId('repo'), { meta: { cwd } })
    startTurn(session, 1)
    await settle(ctx, session)

    await writeFile(join(cwd, 'a.txt'), 'l1\nl2 model\nl3\nl4\n')
    toolCall(session, 1, 'edit', { file_path: 'a.txt' }, { meta: { diffs: [{ path: 'a.txt', oldText: 'l2', newText: 'l2 model' }] } })
    await mkdir(join(cwd, 'sub', 'dir'), { recursive: true })
    await writeFile(join(cwd, 'sub', 'dir', 'c.txt'), 'c\n')
    await writeFile(join(cwd, 'new.txt'), 'n1\nn2\n')
    await writeFile(join(cwd, 'bin.dat'), Uint8Array.of(0, 1, 2, 255))
    toolCall(session, 1, 'bash', { command: 'printf > files' })
    await writeFile(join(cwd, '.env'), 'A=1\nB=2\n')
    toolCall(session, 1, 'write', { file_path: '.env' }, { meta: { diffs: [{ path: '.env', oldText: null, newText: 'A=1\n' }] } })
    toolCall(session, 1, 'edit', { file_path: '.env' }, { meta: { diffs: [{ path: '.env', oldText: 'A=1\n', newText: 'A=1\nB=2\n' }] } })
    toolCall(session, 1, 'write', { file_path: join(tmpdir(), 'scratch.txt') }, {
      meta: { diffs: [{ path: join(tmpdir(), 'scratch.txt'), oldText: null, newText: 'scratch\n' }] },
    })
    toolCall(session, 1, 'write', { file_path: 'ignored-error' }, { isError: true, meta: { diffs: [{ path: 'failed.txt', oldText: null, newText: 'x' }] } })
    toolCall(session, 1, 'write', { file_path: '.env.gone' }, { meta: { diffs: [{ path: '.env.gone', oldText: null, newText: 'x' }] } })
    toolCall(session, 1, 'write', { file_path: 'same.txt' }, { meta: { diffs: [{ path: 'same.txt', oldText: 'same', newText: 'same' }] } })
    toolCall(session, 2, 'write', { file_path: 'other-turn' }, { meta: { diffs: [{ path: 'other.txt', oldText: null, newText: 'x' }] } })
    endTurn(session, 1)
    await settle(ctx, session)

    const [recorded, ...rest] = changes(session)
    expect(rest).toEqual([])
    expect(recorded).toMatchObject({ turn: 1, total: 6 })
    expect(recorded!.snapshot.before).toMatch(/^[0-9a-f]{40,64}$/)
    expect(recorded!.snapshot.after).toMatch(/^[0-9a-f]{40,64}$/)
    expect(recorded!.files).toEqual([
      { path: '.env', display: '.env', added: 2, deleted: 0 },
      { path: '.env.gone', display: '.env.gone', added: 1, deleted: 0 },
      { path: 'a.txt', display: 'a.txt', added: 2, deleted: 1 },
      { path: 'bin.dat', display: 'bin.dat', added: 0, deleted: 0, binary: true },
      { path: 'new.txt', display: 'new.txt', added: 2, deleted: 0 },
      { path: 'sub/dir/c.txt', display: 'sub/dir/c.txt', added: 1, deleted: 0 },
    ])
    expect(git(cwd, 'status', '--porcelain').split('\n').filter(Boolean).sort()).toEqual([
      ' M a.txt', ' M b.txt', '?? bin.dat', '?? new.txt', '?? sub/', '?? u.txt',
    ])
  })

  it('places files above the working directory and outside the repository by their display rule', async () => {
    const root = await repository()
    const cwd = join(root, 'pkg')
    await mkdir(cwd)
    const outside = await mkdtemp(join(homedir(), '.dsh-workspace-changes-test-'))
    cleanups.push(() => rm(outside, { recursive: true, force: true }))
    const { ctx } = await boot()
    const session = ctx.sessions.create(SessionId('nested'), { meta: { cwd } })
    startTurn(session, 1)
    await settle(ctx, session)
    await writeFile(join(root, 'a.txt'), 'changed\n')
    await writeFile(join(cwd, 'inner.txt'), 'inner\n')
    toolCall(session, 1, 'write', { file_path: join(outside, 'note.txt') }, {
      meta: { diffs: [{ path: join(outside, 'note.txt'), oldText: null, newText: 'one\ntwo\nthree\n' }] },
    })
    endTurn(session, 1, 'blocked')
    await settle(ctx, session)
    const [recorded] = changes(session)
    expect(recorded!.files).toEqual([
      { path: join(await realpath(root), 'a.txt'), display: '../a.txt', added: 1, deleted: 3 },
      { path: 'inner.txt', display: 'inner.txt', added: 1, deleted: 0 },
      { path: join(await realpath(outside), 'note.txt'), display: `~/${outside.slice(homedir().length + 1)}/note.txt`, added: 3, deleted: 0 },
    ])
  })

  it('records inside the turn when the agent stops, and again after turn/end only when tools settled later', async () => {
    const cwd = await repository()
    const { ctx } = await boot()
    const session = ctx.sessions.create(SessionId('stopping'), { meta: { cwd } })
    const agent = { session } as never
    const signal = new AbortController().signal
    startTurn(session, 1)
    await ctx.serial('agent/turn-stopping', { agent, turn: 1, signal })
    expect(changes(session)).toEqual([])
    await writeFile(join(cwd, 'one.txt'), '1\n')
    toolCall(session, 1, 'bash', { command: 'x' })
    await ctx.serial('agent/turn-stopping', { agent, turn: 7, signal })
    await ctx.serial('agent/turn-stopping', { agent, turn: 1, signal })
    const inTurn = session.snapshotEvents().find(event => event.type === 'workspace/changes')
    expect(inTurn?.data).toMatchObject({ turn: 1, total: 1 })
    endTurn(session, 1)
    await settle(ctx, session)
    expect(changes(session)).toHaveLength(1)
    expect(session.snapshotEvents().find(event => event.type === 'turn/end')!.seq).toBeGreaterThan(inTurn!.seq)

    startTurn(session, 2)
    await settle(ctx, session)
    await writeFile(join(cwd, 'two.txt'), '2\n')
    toolCall(session, 2, 'bash', { command: 'x' })
    await ctx.serial('agent/turn-stopping', { agent, turn: 2, signal })
    await rm(join(cwd, 'two.txt'))
    toolCall(session, 2, 'bash', { command: 'steered' })
    endTurn(session, 2)
    await settle(ctx, session)
    const second = changes(session).filter(data => data.turn === 2)
    expect(second.map(data => data.files.map(file => file.path))).toEqual([['two.txt'], []])
    expect(second[1]).toMatchObject({ total: 0 })

    startTurn(session, 3)
    await settle(ctx, session)
    toolCall(session, 3, 'read', { file_path: 'a.txt' })
    endTurn(session, 3)
    await settle(ctx, session)
    expect(changes(session).filter(data => data.turn === 3)).toEqual([])
  })

  it('caps the file list while reporting the complete count', async () => {
    const cwd = await repository()
    const { ctx } = await boot({ maxFiles: 2 })
    const session = ctx.sessions.create(SessionId('capped'), { meta: { cwd } })
    startTurn(session, 1)
    await settle(ctx, session)
    for (const name of ['c.txt', 'd.txt', 'e.txt']) await writeFile(join(cwd, name), `${name}\n`)
    toolCall(session, 1, 'bash', { command: 'x' })
    toolCall(session, 1, 'edit', { file_path: 'a.txt' }, { meta: { diffs: [{ path: 'a.txt', oldText: 'l1\n', newText: 'l1\n' }] } })
    endTurn(session, 1)
    await settle(ctx, session)
    const [recorded] = changes(session)
    expect(recorded!.total).toBe(3)
    expect(recorded!.files.map(file => file.display)).toEqual(['c.txt', 'd.txt'])
  })

  it('warns and skips the turn when its git work fails', async () => {
    const cwd = await repository()
    const { ctx } = await boot()
    vi.spyOn(ctx.subprocess, 'resolveExecutable').mockResolvedValue(join(cwd, 'missing-git'))
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const session = ctx.sessions.create(SessionId('warn'), { meta: { cwd } })
    startTurn(session, 1)
    await settle(ctx, session)
    await writeFile(join(cwd, 'x.txt'), 'x\n')
    toolCall(session, 1, 'bash', { command: 'x' })
    endTurn(session, 1)
    await settle(ctx, session)
    expect(changes(session)).toEqual([])
    const own = warn.mock.calls.map(call => String(call[0])).filter(message => message.startsWith('workspace-changes:'))
    expect(own).toHaveLength(1)
    expect(own[0]).toContain('missing-git')
  })

  it('rejects non-positive bounds at load', async () => {
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(SessionStore)
    await ctx.plugin(LocalSubprocessRuntime)
    await expect(ctx.plugin(WorkspaceChanges, { maxFiles: 0 } as WorkspaceChanges.Config)).rejects.toThrow('positive integer maxFiles')
  })
})

describe('workspace-changes without a repository', () => {
  it('records nothing for a working directory outside any git repository', async () => {
    const cwd = await scratchDir('dsh-workspace-changes-plain-', cleanups)
    await writeFile(join(cwd, 'existing.txt'), 'before\n')
    const { ctx } = await boot()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const session = ctx.sessions.create(SessionId('plain'), { meta: { cwd } })
    startTurn(session, 1)
    await settle(ctx, session)
    await writeFile(join(cwd, 'existing.txt'), 'after\nmore\n')
    toolCall(session, 1, 'write', { file_path: 'existing.txt' }, {
      meta: { diffs: [{ path: 'existing.txt', oldText: 'before', newText: 'after\nmore' }] },
    })
    endTurn(session, 1)
    await settle(ctx, session)
    expect(changes(session)).toEqual([])
    expect(warn.mock.calls.filter(call => String(call[0]).startsWith('workspace-changes:'))).toEqual([])
    await expect(stat(join(cwd, '.git'))).rejects.toThrow()
  })

  it('drops a disposed session’s recorder and starts afresh on its next turn', async () => {
    const cwd = await repository()
    const { ctx, fiber } = await boot()
    const session = ctx.sessions.create(SessionId('disposed'), { meta: { cwd } })
    startTurn(session, 1)
    await settle(ctx, session)
    ctx.emit('session/disposed', session)
    await writeFile(join(cwd, 'one.txt'), '1\n')
    toolCall(session, 1, 'bash', { command: 'x' })
    endTurn(session, 1)
    await settle(ctx, session)
    expect(changes(session)).toEqual([])
    startTurn(session, 2)
    await settle(ctx, session)
    await writeFile(join(cwd, 'two.txt'), '2\n')
    toolCall(session, 2, 'bash', { command: 'x' })
    endTurn(session, 2)
    await settle(ctx, session)
    expect(changes(session).map(data => data.files.map(file => file.display))).toEqual([['two.txt']])

    startTurn(session, 3)
    await settle(ctx, session)
    await fiber.dispose()
    await writeFile(join(cwd, 'three.txt'), '3\n')
    toolCall(session, 3, 'bash', { command: 'x' })
    endTurn(session, 3)
    await settle(ctx, session)
    expect(changes(session).filter(data => data.turn === 3)).toEqual([])
  })

  it('ignores subagent sessions and sessions without a working directory', async () => {
    const cwd = await repository()
    const { ctx } = await boot()
    const sessions = [
      ctx.sessions.create(SessionId('child'), { meta: { cwd, delegationDepth: 1 } }),
      ctx.sessions.create(SessionId('origin'), { meta: { cwd, origin: 'subagent' } }),
      ctx.sessions.create(SessionId('nowhere')),
    ]
    for (const session of sessions) {
      startTurn(session, 1)
      await settle(ctx, session)
      toolCall(session, 1, 'bash', { command: 'x' })
      endTurn(session, 1)
      await settle(ctx, session)
      expect(changes(session)).toEqual([])
    }
    await ctx.waterfall('tools/pre-execute', {} as never, () => Promise.resolve(undefined as never))
  })
})

describe('workspace-changes without git', () => {
  it('records nothing and reports the absence once', async () => {
    const cwd = await scratchDir('dsh-workspace-changes-nogit-', cleanups)
    const { ctx } = await boot()
    vi.spyOn(ctx.subprocess, 'resolveExecutable').mockRejectedValue(new Error('git: not found'))
    const info = vi.spyOn(ctx.logger, 'info').mockImplementation(() => undefined)
    const session = ctx.sessions.create(SessionId('nogit'), { meta: { cwd } })
    for (const turn of [1, 2]) {
      startTurn(session, turn)
      await settle(ctx, session)
      await writeFile(join(cwd, `${turn}.txt`), 'x\n')
      toolCall(session, turn, 'bash', { command: 'x' })
      endTurn(session, turn)
      await settle(ctx, session)
    }
    expect(changes(session)).toEqual([])
    expect(info).toHaveBeenCalledTimes(1)
    expect(info.mock.calls[0]![0]).toContain('git is unavailable')
  })

  it('treats the macOS developer-tools stub as absent until a developer directory is selected', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    cleanups.push(async () => { Object.defineProperty(process, 'platform', platform) })
    const probes: Array<{ done: Promise<{ exitCode: number | null; signal: null }>; available: boolean; executable?: string }> = [
      { done: Promise.reject(new Error('spawn failed')), available: false },
      { done: Promise.resolve({ exitCode: 1, signal: null }), available: false },
      { done: Promise.resolve({ exitCode: 0, signal: null }), available: true },
      { done: Promise.resolve({ exitCode: 1, signal: null }), available: true, executable: '/opt/homebrew/bin/git' },
    ]
    for (const probe of probes) {
      probe.done.catch(() => undefined)
      const cwd = await scratchDir('dsh-workspace-changes-stub-', cleanups)
      const { ctx } = await boot()
      vi.spyOn(ctx.subprocess, 'resolveExecutable').mockResolvedValue(probe.executable ?? '/usr/bin/git')
      const real = ctx.subprocess.spawn.bind(ctx.subprocess)
      const spawn = vi.spyOn(ctx.subprocess, 'spawn').mockImplementation(spec =>
        spec.argv[0] === '/usr/bin/xcode-select' ? { done: probe.done } as never : real(spec))
      const info = vi.spyOn(ctx.logger, 'info').mockImplementation(() => undefined)
      vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
      const session = ctx.sessions.create(SessionId('stub'), { meta: { cwd } })
      startTurn(session, 1)
      await settle(ctx, session)
      expect(spawn.mock.calls.some(call => call[0].argv[0] === '/usr/bin/xcode-select')).toBe(probe.executable === undefined)
      expect(info).toHaveBeenCalledTimes(probe.available ? 0 : 1)
      await ctx.fiber.dispose()
    }
  })
})
