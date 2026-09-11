/** Git working-tree snapshots, tree diffs, and ignore checks through the subprocess capability. */
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { parseNumstat, type NumstatEntry } from './numstat.ts'

/** Milliseconds a git child gets to exit after termination starts; a fixed lifecycle constant. */
const TERMINATE_GRACE_MS = 2_000
/** Retained stderr tail for diagnostics. */
const STDERR_TAIL_BYTES = 16 * 1024

/** Settled git command facts; a nonzero exit is a result, not an exception. */
export interface GitRunResult {
  exitCode: number | null
  stdout: string
  stderr: string
  /** True when stdout exceeded the output cap and lost its head. */
  truncated: boolean
}

/** Per-command spawn facts. */
export interface GitRunOptions {
  cwd: string
  env?: Readonly<Record<string, string>> | undefined
  stdin?: string | undefined
  signal: AbortSignal
}

/** Bounds every git command runs under. */
export interface GitLimits {
  /** Milliseconds before a command is terminated. */
  timeoutMs: number
  /** In-memory stdout cap in bytes. */
  outputMaxBytes: number
}

/** Runs one resolved git executable with scrubbed environment, timeout, and bounded output. */
export class GitRunner {
  constructor(
    private readonly subprocess: SubprocessRuntime,
    private readonly executable: string,
    private readonly limits: GitLimits,
  ) {}

  /**
   * Run `git <args>` to completion.
   * @param args - git arguments; never shell-interpreted.
   * @param options - working directory, extra environment, stdin data, and cancellation.
   * @returns exit facts and collected output.
   * @throws when the command times out, is aborted, or cannot spawn.
   */
  async run(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
    const timeout = AbortSignal.timeout(this.limits.timeoutMs)
    const signal = AbortSignal.any([options.signal, timeout])
    const handle = this.subprocess.spawn({
      argv: [this.executable, ...args],
      cwd: options.cwd,
      stdio: {
        stdin: options.stdin === undefined ? 'ignore' : { data: options.stdin },
        stdout: { maxBytes: this.limits.outputMaxBytes },
        stderr: { maxBytes: STDERR_TAIL_BYTES },
      },
      graceMs: TERMINATE_GRACE_MS,
      signal,
      env: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', ...options.env },
    })
    const outcome = await handle.done
    if (signal.aborted) {
      throw new Error(`git ${args.join(' ')} ${timeout.aborted ? `timed out after ${this.limits.timeoutMs}ms` : 'was aborted'}`)
    }
    /* v8 ignore start -- collect-mode stdio always yields both readers. */
    const stdout = handle.collected.stdout?.readFrom(0) ?? { text: '', lossy: false }
    const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
    /* v8 ignore stop */
    return { exitCode: outcome.exitCode, stdout: stdout.text, stderr, truncated: stdout.lossy }
  }
}

/**
 * Reject a failed command with its stderr.
 * @param result - settled command facts.
 * @param what - command description for the error message.
 * @returns the same result when it exited zero.
 */
function ok(result: GitRunResult, what: string): GitRunResult {
  if (result.exitCode !== 0) throw new Error(`${what} failed: ${result.stderr.trim()}`)
  return result
}

/** The repository enclosing a Session working directory. */
export interface GitWorkspace {
  /** Repository top-level directory, the root every diff path is relative to. */
  root: string
  /** Absolute git directory holding the index and objects. */
  gitDir: string
}

/**
 * Locate the repository enclosing a working directory.
 * @param git - command runner.
 * @param cwd - absolute Session working directory.
 * @param signal - cancellation.
 * @returns the repository, or null when the directory is not inside one.
 */
export async function locateGitWorkspace(git: GitRunner, cwd: string, signal: AbortSignal): Promise<GitWorkspace | null> {
  const found = await git.run(['rev-parse', '--show-toplevel', '--absolute-git-dir'], { cwd, signal })
  if (found.exitCode !== 0) return null
  const [root, gitDir] = found.stdout.split('\n') as [string, string]
  return { root, gitDir }
}

/**
 * Write the complete work tree, including untracked and modified files but
 * not ignored ones, as a tree object through a private index seeded from the
 * repository's index. That index, the work tree, and every ref stay unchanged;
 * an in-progress merge keeps its unmerged entries.
 * @param git - command runner.
 * @param workspace - addressed repository.
 * @param signal - cancellation.
 * @returns the tree object id.
 */
export async function snapshotTree(git: GitRunner, workspace: GitWorkspace, signal: AbortSignal): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-workspace-changes-'))
  try {
    const index = join(scratch, 'index')
    // A repository without an index yet (fresh `git init`) starts from scratch.
    await copyFile(join(workspace.gitDir, 'index'), index).then(() => undefined, () => undefined)
    const env = { GIT_INDEX_FILE: index }
    ok(await git.run(['add', '--all', '--ignore-errors'], { cwd: workspace.root, env, signal }), `git add in ${workspace.root}`)
    return ok(await git.run(['write-tree'], { cwd: workspace.root, env, signal }), 'git write-tree').stdout.trim()
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/**
 * Per-file line counts between two snapshot trees, with renames detected.
 * @param git - command runner.
 * @param workspace - addressed repository.
 * @param before - turn-start tree id.
 * @param after - turn-end tree id.
 * @param signal - cancellation.
 * @returns changed files relative to the repository root.
 * @throws when git fails or the output exceeded the cap.
 */
export async function diffTrees(
  git: GitRunner, workspace: GitWorkspace, before: string, after: string, signal: AbortSignal,
): Promise<NumstatEntry[]> {
  if (before === after) return []
  const result = ok(await git.run(['diff-tree', '-r', '-M', '-z', '--numstat', before, after], { cwd: workspace.root, signal }), 'git diff-tree')
  if (result.truncated) throw new Error('git diff-tree output exceeded the configured cap')
  return parseNumstat(result.stdout)
}

/**
 * The subset of work-tree paths that the repository ignores. Tracked files
 * are never reported, so a tracked file matching an ignore pattern still
 * counts as covered by snapshots.
 * @param git - command runner.
 * @param workspace - addressed repository.
 * @param paths - slash-separated paths relative to the repository root.
 * @param signal - cancellation.
 * @returns the ignored members of `paths`.
 */
export async function ignoredPaths(
  git: GitRunner, workspace: GitWorkspace, paths: readonly string[], signal: AbortSignal,
): Promise<Set<string>> {
  if (paths.length === 0) return new Set()
  const result = await git.run(['check-ignore', '-z', '--stdin'], { cwd: workspace.root, stdin: `${paths.join('\0')}\0`, signal })
  if (result.exitCode === 1) return new Set()
  return new Set(ok(result, 'git check-ignore').stdout.split('\0').filter(path => path !== ''))
}
