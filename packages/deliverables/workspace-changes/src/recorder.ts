/** Per-Session turn recorder: snapshot at turn start, diff at turn end, summary kept until disposal. */
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { FileDiff } from '@deepseek-ai/dsh-tools'
import { diffTrees, gitlinkPaths, ignoredPaths, locateGitWorkspace, snapshotTree, type GitRunner, type GitWorkspace } from './git.ts'
import { argumentHunks, fileDiffsOf, hunkLineCounts } from './numstat.ts'
import { canonicalPath, compareDisplay, displayPathOf, durablePathOf, isInside, isTemporaryPath, temporaryRoots, toPosix } from './paths.ts'
import type { WorkspaceChangedFile, WorkspaceChangesSummary } from './types.ts'

/** Facts shared by every recorder of one plugin instance. */
export interface RecorderEnvironment {
  /** Resolves to the runner, or null when git is unavailable and no turn records anything. */
  git: Promise<GitRunner | null>
  /** Directory that receives each Session's snapshot object directory. */
  tempRoot: string
  /** Maximum files carried by one summary. */
  maxFiles: number
  /** Failure reporter; a failed turn records nothing and the next turn retries. */
  warn: (message: string) => void
}

/** Canonical paths every comparison and display uses, resolved once per Session. */
interface Paths {
  /** Canonical working directory; git reports symlink-resolved paths, so every comparison uses that form. */
  cwd: string
  /** Canonical home directory abbreviated as `~` in display paths. */
  home: string
  /** Temporary roots whose files outside the workspace never enter a summary. */
  temporaryRoots: readonly string[]
}

/** The repository enclosing the working directory and the runner that snapshots it. */
interface Repository {
  git: GitRunner
  workspace: GitWorkspace
}

/** The turn-start snapshot of a located repository. */
interface Baseline extends Repository { tree: string }

/** Everything one turn accumulates; a new turn gets a new object so queued work for an older turn keeps its own. */
interface TurnState {
  readonly turn: number
  /**
   * The turn-start snapshot once it exists. `null` means no repository or no git, so the turn summarizes file-tool
   * hunks only; `'failed'` means the repository exists but its snapshot failed, so the turn records nothing.
   */
  baseline: Baseline | null | 'failed'
  /** Hunks derived from each mutation call's arguments, or null for a call that changes no file. */
  readonly calls: Map<string, FileDiff[] | null>
  /** File-tool hunks by their model-facing path; canonicalized when the record is built. */
  readonly hunks: Map<string, FileDiff[]>
  lastToolResultSeq: number
  /** Log length when the latest record attempt started; `end()` skips a turn already attempted after its last tool result. */
  attemptedAfterSeq: number
  /** Sequence of the latest appended event, or -1. */
  recordedAfterSeq: number
}

function freshState(turn: number): TurnState {
  return { turn, baseline: null, calls: new Map(), hunks: new Map(), lastToolResultSeq: -1, attemptedAfterSeq: -1, recordedAfterSeq: -1 }
}

/**
 * Serializes one Session's git work: the turn-start snapshot, the turn-end
 * snapshot with its diff, and the appended `workspace/changes` event whose
 * summary this recorder keeps. Snapshot objects live in a temporary directory
 * owned by the recorder; disposal removes it together with the summaries.
 * Tool execution waits for pending work so a snapshot never races a mutation.
 * A working directory outside any repository, or a Host without git, gets no
 * snapshot; its summary lists the files the file tools changed.
 */
export class TurnRecorder {
  private chain: Promise<void> = Promise.resolve()
  /** The open turn; before the first `turn/start` it is an empty placeholder no event can match. */
  private state = freshState(0)
  /** Canonical paths, resolved by the first turn. */
  private paths: Paths | undefined
  /** The located repository, reused across turns once found; null keeps retrying each turn. */
  private repository: Repository | null = null
  /** Temporary directory holding this Session's snapshot objects and scratch indexes, created with the first located repository. */
  private scratch: string | undefined
  /** Summaries by the sequence of the event that announced them. */
  private readonly summaries = new Map<number, WorkspaceChangesSummary>()
  private readonly lifetime = new AbortController()

  constructor(
    private readonly session: Session,
    private readonly cwd: string,
    private readonly env: RecorderEnvironment,
  ) {}

  /**
   * Open a turn with fresh per-turn state and queue its baseline snapshot.
   * @param turn - the turn number from `turn/start`.
   */
  start(turn: number): void {
    const state = freshState(turn)
    this.state = state
    void this.enqueue(async (signal) => {
      try {
        this.paths ??= { cwd: await realpath(this.cwd), home: await canonicalPath(homedir()), temporaryRoots: await temporaryRoots() }
        const repository = await this.locate(this.paths.cwd, signal)
        if (repository === null) return
        const tree = await snapshotTree(repository.git, repository.workspace, signal)
        state.baseline = { ...repository, tree }
      } catch (error: unknown) {
        // A repository whose snapshot failed must not be summarized as if it had none.
        state.baseline = 'failed'
        throw error
      }
    })
  }

  /**
   * Remember a mutation call's arguments so a result without persisted hunks can still count its lines.
   * @param event - the appended `tool/call` event.
   */
  observeCall(event: SessionEvent<'tool/call'>): void {
    const state = this.state
    if (event.data.turn !== state.turn) return
    state.calls.set(String(event.data.callId), argumentHunks(event.data.name, event.data.arguments))
  }

  /**
   * Remember a settled tool result and the hunks it carries, falling back to the call's arguments.
   * @param event - the appended `tool/result` event.
   */
  observe(event: SessionEvent<'tool/result'>): void {
    const state = this.state
    if (event.data.turn !== state.turn) return
    state.lastToolResultSeq = event.seq
    if (event.data.message.content[0].isError === true) return
    const diffs = fileDiffsOf(event.data.meta) ?? state.calls.get(String(event.data.message.source.callId)) ?? []
    for (const diff of diffs) {
      const list = state.hunks.get(diff.path)
      if (list === undefined) state.hunks.set(diff.path, [diff])
      else list.push(diff)
    }
  }

  /**
   * Record the turn's changes inside the turn, before `turn/end` commits.
   * @param turn - the stopping turn.
   * @returns after the event is appended or the attempt failed.
   */
  stopping(turn: number): Promise<void> {
    const state = this.state
    if (turn !== state.turn) return Promise.resolve()
    return this.enqueue(signal => this.record(state, signal))
  }

  /**
   * Record after `turn/end` unless a record was already attempted after the turn's last tool result.
   * @param turn - the turn number from `turn/end`.
   */
  end(turn: number): void {
    const state = this.state
    if (turn !== state.turn || state.attemptedAfterSeq >= state.lastToolResultSeq) return
    void this.enqueue(signal => this.record(state, signal))
  }

  /** Resolves once every queued snapshot and record has settled. */
  settled(): Promise<void> {
    return this.chain
  }

  /**
   * The summary announced by one `workspace/changes` event of this Session.
   * @param seq - the event's sequence number.
   * @returns the summary, or undefined for a sequence this recorder did not announce.
   */
  summary(seq: number): WorkspaceChangesSummary | undefined {
    return this.summaries.get(seq)
  }

  /**
   * Abort queued git work, forget every summary, and remove the snapshot objects.
   * @returns once the temporary directory is gone.
   */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    this.summaries.clear()
    await this.chain
    if (this.scratch !== undefined) await rm(this.scratch, { recursive: true, force: true })
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

  /** The repository enclosing the working directory, located once; null keeps retrying each turn. */
  private async locate(cwd: string, signal: AbortSignal): Promise<Repository | null> {
    if (this.repository !== null) return this.repository
    const git = await this.env.git
    if (git === null) return null
    const workspace = await locateGitWorkspace(git, cwd, async () => {
      this.scratch ??= await mkdtemp(join(this.env.tempRoot, 'dsh-workspace-changes-'))
      return this.scratch
    }, signal)
    if (workspace === null) return null
    this.repository = { git, workspace }
    return this.repository
  }

  private async record(state: TurnState, signal: AbortSignal): Promise<void> {
    const paths = this.paths
    const { baseline } = state
    if (paths === undefined || baseline === 'failed' || state.lastToolResultSeq < 0) return
    state.attemptedAfterSeq = state.lastToolResultSeq
    // Without a snapshot the working directory itself bounds the workspace.
    const root = baseline?.workspace.root ?? paths.cwd
    const files = new Map<string, WorkspaceChangedFile>()
    let snapshot: WorkspaceChangesSummary['snapshot']
    if (baseline !== null) {
      const after = await snapshotTree(baseline.git, baseline.workspace, signal)
      snapshot = { before: baseline.tree, after }
      for (const entry of await diffTrees(baseline.git, baseline.workspace, baseline.tree, after, signal)) {
        const absolute = resolve(root, entry.path)
        files.set(absolute, changedFile(paths, root, absolute, entry))
      }
    }
    // File-tool hunks by canonical absolute path, for the files snapshots do not cover.
    const hunks = new Map<string, FileDiff[]>()
    for (const [path, list] of state.hunks) {
      const absolute = await canonicalPath(resolve(paths.cwd, path))
      if (!files.has(absolute)) hunks.set(absolute, [...hunks.get(absolute) ?? [], ...list])
    }
    const workTreePath = (absolute: string): string => toPosix(relative(root, absolute))
    let inWorkspace = [...hunks.keys()].filter(absolute => isInside(root, absolute))
    if (baseline !== null && inWorkspace.length > 0) {
      // Nested repositories and submodules are gitlinks: their contents never enter the summary.
      const gitlinks = await gitlinkPaths(baseline.git, baseline.workspace, signal)
      inWorkspace = inWorkspace.filter(absolute => ![...gitlinks].some(link => isInside(resolve(root, link), absolute)))
    }
    // A snapshot covers every workspace file except the ignored ones; without one, every file-tool edit counts.
    const uncoveredInWorkspace = baseline === null
      ? new Set(inWorkspace.map(workTreePath))
      : await ignoredPaths(baseline.git, baseline.workspace, inWorkspace.map(workTreePath), signal)
    for (const [absolute, list] of hunks) {
      // Outside the workspace, scratch files under a temporary root stay out.
      const uncovered = isInside(root, absolute)
        ? uncoveredInWorkspace.has(workTreePath(absolute))
        : !isTemporaryPath(absolute, paths.temporaryRoots)
      if (uncovered) files.set(absolute, changedFile(paths, root, absolute, { ...hunkLineCounts(list), binary: false }))
    }
    const sorted = [...files.values()].sort(compareDisplay)
    // An empty list after an earlier in-turn record supersedes that record.
    if (sorted.length === 0 && state.recordedAfterSeq < 0) return
    const event = this.session.append('workspace/changes', { turn: state.turn })
    this.summaries.set(event.seq, {
      turn: state.turn,
      cwd: this.cwd,
      files: sorted.slice(0, this.env.maxFiles),
      total: sorted.length,
      added: sorted.reduce((sum, file) => sum + file.added, 0),
      deleted: sorted.reduce((sum, file) => sum + file.deleted, 0),
      ...snapshot === undefined ? {} : { snapshot },
    })
    state.recordedAfterSeq = event.seq
  }
}

function changedFile(
  { cwd, home }: Paths, root: string, absolute: string, counts: { added: number; deleted: number; binary: boolean },
): WorkspaceChangedFile {
  return {
    path: durablePathOf(absolute, cwd),
    display: displayPathOf(absolute, cwd, root, home),
    added: counts.added,
    deleted: counts.deleted,
    ...counts.binary ? { binary: true as const } : {},
  }
}
