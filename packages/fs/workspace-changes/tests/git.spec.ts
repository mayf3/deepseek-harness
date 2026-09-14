/** Git command bounds, snapshot recovery, and diff failure reporting. */
import { chmod, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { GitRunner, diffTrees, ignoredPaths, locateGitWorkspace, snapshotTree } from '../src/git.ts'
import { TurnRecorder } from '../src/recorder.ts'
import { temporaryRoots } from '../src/paths.ts'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { git, scratchDir } from './support.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

async function runner(limits = { timeoutMs: 30_000, outputMaxBytes: 1024 * 1024 }, executable = 'git') {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(LocalSubprocessRuntime)
  return { ctx, git: new GitRunner(ctx.subprocess, await ctx.subprocess.resolveExecutable(executable).catch(() => executable), limits) }
}

const signal = new AbortController().signal

describe('GitRunner', () => {
  it('reports timeouts and external aborts as failures', async () => {
    const cwd = await scratchDir('dsh-git-runner-', cleanups)
    const { git: slow } = await runner({ timeoutMs: 1, outputMaxBytes: 1024 })
    await expect(slow.run(['--version'], { cwd, signal })).rejects.toThrow('timed out after 1ms')
    const { git: quick } = await runner()
    const aborted = new AbortController()
    setTimeout(() => { aborted.abort() }, 0)
    await expect(quick.run(['--version'], { cwd, signal: aborted.signal })).rejects.toThrow('git --version was aborted')
    const ok = await quick.run(['--version'], { cwd, signal })
    expect(ok.exitCode).toBe(0)
    expect(ok.stdout).toContain('git version')
  })
})

describe('snapshots and diffs', () => {
  it('snapshots a repository whose index holds unmerged entries without touching that index', async () => {
    const cwd = await scratchDir('dsh-git-conflict-', cleanups)
    git(cwd, 'init', '-q', '-b', 'main')
    await writeFile(join(cwd, 'f.txt'), 'base\n')
    git(cwd, 'add', '-A'); git(cwd, 'commit', '-q', '-m', 'base')
    git(cwd, 'checkout', '-q', '-b', 'side')
    await writeFile(join(cwd, 'f.txt'), 'side\n')
    git(cwd, 'commit', '-q', '-am', 'side')
    git(cwd, 'checkout', '-q', 'main')
    await writeFile(join(cwd, 'f.txt'), 'main\n')
    git(cwd, 'commit', '-q', '-am', 'main')
    expect(() => git(cwd, 'merge', 'side')).toThrow()
    expect(git(cwd, 'status', '--porcelain')).toContain('UU f.txt')
    const { git: runnerGit } = await runner()
    const workspace = await locateGitWorkspace(runnerGit, cwd, { home: await scratchDir('dsh-git-store-', cleanups), maxBytes: 1024 * 1024 }, signal)
    expect(workspace?.root).toBe(await realpath(cwd))
    const tree = await snapshotTree(runnerGit, workspace!, signal)
    expect(tree).toMatch(/^[0-9a-f]{40,64}$/)
    expect(git(cwd, 'status', '--porcelain')).toContain('UU f.txt')
  })

  it('fails loudly when the addressed repository cannot be written or diffed', async () => {
    const cwd = await scratchDir('dsh-git-broken-', cleanups)
    const { git: runnerGit } = await runner()
    const store = { home: await scratchDir('dsh-git-store-', cleanups), maxBytes: 1024 * 1024 }
    expect(await locateGitWorkspace(runnerGit, cwd, store, signal)).toBeNull()
    const broken = { root: cwd, gitDir: join(cwd, 'missing'), objectsDir: join(cwd, 'missing-objects'), env: {} }
    await expect(snapshotTree(runnerGit, broken, signal)).rejects.toThrow('git add in')
    await expect(ignoredPaths(runnerGit, broken, ['x'], signal)).rejects.toThrow('git check-ignore failed')
    expect(await ignoredPaths(runnerGit, broken, [], signal)).toEqual(new Set())
    git(cwd, 'init', '-q')
    const workspace = (await locateGitWorkspace(runnerGit, cwd, store, signal))!
    await expect(diffTrees(runnerGit, workspace, 'a'.repeat(40), 'b'.repeat(40), signal)).rejects.toThrow('git diff-tree failed')
    await writeFile(join(cwd, 'many.txt'), Array.from({ length: 50 }, (_, index) => `line ${index}`).join('\n'))
    const before = await snapshotTree(runnerGit, workspace, signal)
    await writeFile(join(cwd, 'many.txt'), 'gone')
    for (let index = 0; index < 20; index += 1) await writeFile(join(cwd, `file-${index}.txt`), 'x\n')
    const after = await snapshotTree(runnerGit, workspace, signal)
    const { git: tiny } = await runner({ timeoutMs: 30_000, outputMaxBytes: 16 })
    await expect(diffTrees(tiny, workspace, before, after, signal)).rejects.toThrow('exceeded')
    expect((await diffTrees(runnerGit, workspace, before, after, signal)).length).toBe(21)
  })

})

describe('repository edge cases', () => {
  it.skipIf(process.platform === 'win32')('snapshots past an unreadable file and refuses an unreadable index', async () => {
    const cwd = await scratchDir('dsh-git-unreadable-', cleanups)
    git(cwd, 'init', '-q', '-b', 'main')
    await writeFile(join(cwd, 'ok.txt'), 'ok\n')
    await writeFile(join(cwd, 'locked.txt'), 'locked\n')
    await chmod(join(cwd, 'locked.txt'), 0o000)
    cleanups.push(() => chmod(join(cwd, 'locked.txt'), 0o644))
    const { git: runnerGit } = await runner()
    const store = { home: await scratchDir('dsh-git-store-', cleanups), maxBytes: 1024 * 1024 }
    const workspace = (await locateGitWorkspace(runnerGit, cwd, store, signal))!
    expect(await snapshotTree(runnerGit, workspace, signal)).toMatch(/^[0-9a-f]{40,64}$/)
    git(cwd, 'add', 'ok.txt')
    await chmod(join(workspace.gitDir, 'index'), 0o000)
    cleanups.push(() => chmod(join(workspace.gitDir, 'index'), 0o644))
    await expect(snapshotTree(runnerGit, workspace, signal)).rejects.toThrow(/EACCES/)
  })

  it('reports a repository git cannot read instead of treating it as absent', async () => {
    const cwd = await scratchDir('dsh-git-unsupported-', cleanups)
    git(cwd, 'init', '-q')
    const config = join(cwd, '.git', 'config')
    const original = await readFile(config, 'utf8')
    await writeFile(config, original.replace(/repositoryformatversion = \d+/, 'repositoryformatversion = 99'))
    const { git: runnerGit } = await runner()
    const store = { home: await scratchDir('dsh-git-store-', cleanups), maxBytes: 1024 * 1024 }
    await expect(locateGitWorkspace(runnerGit, cwd, store, signal)).rejects.toThrow('git rev-parse failed')
    await writeFile(config, original)
    const blocked = join(cwd, 'store-file')
    await writeFile(blocked, 'not a directory')
    await expect(locateGitWorkspace(runnerGit, cwd, { home: blocked, maxBytes: 1 }, signal)).rejects.toThrow(/ENOTDIR/)
  })
})

describe('TurnRecorder', () => {
  it('stays silent when disposed while git work is pending, and warns on failures otherwise', async () => {
    const cwd = await scratchDir('dsh-recorder-', cleanups)
    const { ctx, git: runnerGit } = await runner()
    const session = ctx.sessions.create(SessionId('recorder'), { meta: { cwd } })
    const warnings: string[] = []
    let release!: (runner: GitRunner | null) => void
    const gate = new Promise<GitRunner | null>((resolve) => { release = resolve })
    const env = {
      git: gate, objects: { home: await scratchDir('dsh-git-store-', cleanups), maxBytes: 1024 * 1024 },
      home: '', temporaryRoots: temporaryRoots(), maxFiles: 10, warn: (m: string) => { warnings.push(m) },
    }
    const disposed = new TurnRecorder(session, cwd, env)
    disposed.start(1)
    await new Promise(resolve => setTimeout(resolve, 5))
    disposed.dispose()
    release(runnerGit)
    await disposed.settled()
    disposed.start(2)
    await disposed.settled()
    expect(warnings).toEqual([])

    const { git: missing } = await runner(undefined, '/nonexistent/git-binary')
    const failing = new TurnRecorder(session, cwd, { ...env, git: Promise.resolve(missing) })
    failing.start(1)
    await failing.settled()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('workspace-changes:')
  })
})
