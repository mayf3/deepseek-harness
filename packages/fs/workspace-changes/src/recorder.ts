/** Per-Session turn recorder: snapshot at turn start, diff and append at turn end. */
import { realpath } from 'node:fs/promises'
import { relative } from 'node:path'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { FileDiff } from '@deepseek-ai/dsh-tools'
import { diffTrees, ignoredPaths, locateGitWorkspace, snapshotTree, type GitRunner, type GitWorkspace, type ObjectStoreOptions } from './git.ts'
import { fileDiffsOf, hunkLineCounts } from './numstat.ts'
import { absolutePathOf, compareDisplay, displayPathOf, durablePathOf, isInside, isTemporaryPath, toPosix } from './paths.ts'
import type { WorkspaceChangedFile } from './types.ts'

/** Facts shared by every recorder of one plugin instance. */
export interface RecorderEnvironment {
  /** Resolves to the runner, or null when git is unavailable and no turn records anything. */
  git: Promise<GitRunner | null>
  /** Where snapshot objects live and how large one repository's store may grow. */
  objects: ObjectStoreOptions
  /** Canonical absolute home directory abbreviated as `~` in display paths. */
  home: string
  /** Temporary roots whose files never enter a summary. */
  temporaryRoots: readonly string[]
  /** Maximum files carried by one event. */
  maxFiles: number
  /** Failure reporter; a failed turn records nothing and the next turn retries. */
  warn: (message: string) => void
}

interface Baseline { git: GitRunner; workspace: GitWorkspace; tree: string; cwd: string }

/** Symlink-resolved path when the target exists, otherwise the lexical path. */
async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    // A deleted or unreadable target keeps its lexical spelling.
    return path
  }
}

/**
 * Serializes one Session's git work: the turn-start snapshot, the turn-end
 * snapshot with its diff, and the appended `workspace/changes` event. Tool
 * execution waits for pending work so a snapshot never races a mutation. A
 * working directory outside any repository records nothing.
 */
export class TurnRecorder {
  private chain: Promise<void> = Promise.resolve()
  private baseline: Baseline | null = null
  private turn = 0
  /** File-tool hunks by their model-facing path; canonicalized when the record is built. */
  private hunks = new Map<string, FileDiff[]>()
  private lastToolResultSeq = -1
  private recordedAfterSeq = -1
  private readonly lifetime = new AbortController()

  constructor(
    private readonly session: Session,
    private readonly cwd: string,
    private readonly env: RecorderEnvironment,
  ) {}

  /** Open a turn: reset per-turn state and queue the baseline snapshot. */
  start(turn: number): void {
    this.turn = turn
    this.baseline = null
    this.hunks = new Map()
    this.lastToolResultSeq = -1
    this.recordedAfterSeq = -1
    void this.enqueue(async (signal) => {
      const git = await this.env.git
      if (git === null) return
      // git reports symlink-resolved paths; every comparison uses that form.
      const cwd = await realpath(this.cwd)
      const workspace = await locateGitWorkspace(git, cwd, this.env.objects, signal)
      if (workspace === null) return
      const tree = await snapshotTree(git, workspace, signal)
      this.baseline = { git, workspace, tree, cwd }
    })
  }

  /** Remember a settled tool result and any file-tool hunks it carries. */
  observe(event: SessionEvent<'tool/result'>): void {
    if (event.data.turn !== this.turn) return
    this.lastToolResultSeq = event.seq
    if (event.data.message.content[0].isError === true) return
    const diffs = fileDiffsOf(event.data.meta)
    if (diffs === undefined) return
    for (const diff of diffs) {
      const list = this.hunks.get(diff.path)
      if (list === undefined) this.hunks.set(diff.path, [diff])
      else list.push(diff)
    }
  }

  /**
   * Record the turn's changes inside the turn, before `turn/end` commits.
   * @param turn - the stopping turn.
   * @returns after the event is appended or the attempt failed.
   */
  stopping(turn: number): Promise<void> {
    if (turn !== this.turn) return Promise.resolve()
    return this.enqueue(signal => this.record(signal))
  }

  /** Record after `turn/end` when the in-turn record is missing or stale. */
  end(turn: number): void {
    if (turn !== this.turn || this.recordedAfterSeq >= this.lastToolResultSeq) return
    void this.enqueue(signal => this.record(signal))
  }

  /** Resolves once every queued snapshot and record has settled. */
  settled(): Promise<void> {
    return this.chain
  }

  /** Abort queued git work; the recorder accepts nothing afterwards. */
  dispose(): void {
    this.lifetime.abort()
  }

  private enqueue(task: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const run = this.chain.then(async () => {
      if (this.lifetime.signal.aborted) return
      try {
        await task(this.lifetime.signal)
      } catch (error: unknown) {
        this.warnUnlessDisposed(error)
      }
    })
    this.chain = run
    return run
  }

  /** A failure after disposal is expected cancellation and stays silent. */
  private warnUnlessDisposed(error: unknown): void {
    if (!this.lifetime.signal.aborted) this.env.warn(`workspace-changes: ${String(error)}`)
  }

  private async record(signal: AbortSignal): Promise<void> {
    if (this.baseline === null || this.lastToolResultSeq < 0) return
    const { git, workspace, tree: before, cwd } = this.baseline
    const after = await snapshotTree(git, workspace, signal)
    const files = new Map<string, WorkspaceChangedFile>()
    for (const entry of await diffTrees(git, workspace, before, after, signal)) {
      const absolute = absolutePathOf(workspace.root, entry.path)
      files.set(absolute, this.changedFile(absolute, cwd, workspace, entry))
    }
    const hunks = new Map<string, FileDiff[]>()
    for (const [path, list] of this.hunks) {
      const absolute = await canonicalPath(absolutePathOf(cwd, path))
      hunks.set(absolute, [...hunks.get(absolute) ?? [], ...list])
    }
    const inside: string[] = []
    const outside: string[] = []
    for (const absolute of hunks.keys()) {
      if (files.has(absolute)) continue
      // The working directory is the user's workspace even when it lives under a temporary root.
      if (!isInside(cwd, absolute) && isTemporaryPath(absolute, this.env.temporaryRoots)) continue
      if (isInside(workspace.root, absolute)) inside.push(absolute)
      else outside.push(absolute)
    }
    const workTreePath = (absolute: string): string => toPosix(relative(workspace.root, absolute))
    const ignored = await ignoredPaths(git, workspace, inside.map(workTreePath), signal)
    const toolOnly = new Set([...outside, ...inside.filter(absolute => ignored.has(workTreePath(absolute)))])
    for (const [absolute, list] of hunks) {
      if (!toolOnly.has(absolute)) continue
      files.set(absolute, this.changedFile(absolute, cwd, workspace, { ...hunkLineCounts(list), binary: false }))
    }
    const sorted = [...files.values()].sort(compareDisplay)
    // An empty list after an earlier in-turn record supersedes that record.
    if (sorted.length === 0 && this.recordedAfterSeq < 0) return
    const event = this.session.append('workspace/changes', {
      turn: this.turn,
      files: sorted.slice(0, this.env.maxFiles),
      total: sorted.length,
      snapshot: { before, after },
    })
    this.recordedAfterSeq = event.seq
  }

  private changedFile(
    absolute: string, cwd: string, workspace: GitWorkspace, counts: { added: number; deleted: number; binary: boolean },
  ): WorkspaceChangedFile {
    return {
      path: durablePathOf(absolute, cwd),
      display: displayPathOf(absolute, cwd, workspace.root, this.env.home),
      added: counts.added,
      deleted: counts.deleted,
      ...counts.binary ? { binary: true as const } : {},
    }
  }
}
