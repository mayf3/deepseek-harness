/** Per-Session turn recorder: snapshot at turn start, diff and append at turn end. */
import { realpath } from 'node:fs/promises'
import { relative } from 'node:path'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { FileDiff } from '@deepseek-ai/dsh-tools'
import { diffTrees, ignoredPaths, locateGitWorkspace, snapshotTree, type GitRunner, type GitWorkspace, type ObjectStoreOptions } from './git.ts'
import { argumentHunks, fileDiffsOf, hunkLineCounts } from './numstat.ts'
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

/** Everything one turn accumulates; a new turn gets a new object so queued work for an older turn keeps its own. */
interface TurnState {
  readonly turn: number
  baseline: Baseline | null
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
  /** The open turn; before the first `turn/start` it is an empty placeholder no event can match. */
  private state = freshState(0)
  /** The located repository, reused across turns once found; null keeps retrying each turn. */
  private workspace: { git: GitRunner; cwd: string; workspace: GitWorkspace } | null = null
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
      const located = await this.locate(signal)
      if (located === null) return
      const tree = await snapshotTree(located.git, located.workspace, signal)
      state.baseline = { ...located, tree }
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

  /** The repository for this Session, located once; git reports symlink-resolved paths, so every comparison uses that form. */
  private async locate(signal: AbortSignal): Promise<{ git: GitRunner; cwd: string; workspace: GitWorkspace } | null> {
    if (this.workspace !== null) return this.workspace
    const git = await this.env.git
    if (git === null) return null
    const cwd = await realpath(this.cwd)
    const workspace = await locateGitWorkspace(git, cwd, this.env.objects, signal)
    if (workspace === null) return null
    this.workspace = { git, cwd, workspace }
    return this.workspace
  }

  private async record(state: TurnState, signal: AbortSignal): Promise<void> {
    if (state.baseline === null || state.lastToolResultSeq < 0) return
    state.attemptedAfterSeq = state.lastToolResultSeq
    const { git, workspace, tree: before, cwd } = state.baseline
    const after = await snapshotTree(git, workspace, signal)
    const files = new Map<string, WorkspaceChangedFile>()
    for (const entry of await diffTrees(git, workspace, before, after, signal)) {
      const absolute = absolutePathOf(workspace.root, entry.path)
      files.set(absolute, this.changedFile(absolute, cwd, workspace, entry))
    }
    const hunks = new Map<string, FileDiff[]>()
    for (const [path, list] of state.hunks) {
      const absolute = await canonicalPath(absolutePathOf(cwd, path))
      hunks.set(absolute, [...hunks.get(absolute) ?? [], ...list])
    }
    const inside: string[] = []
    const outside: string[] = []
    for (const absolute of hunks.keys()) {
      if (files.has(absolute)) continue
      // The repository is the user's workspace even when it lives under a temporary root.
      if (!isInside(workspace.root, absolute) && isTemporaryPath(absolute, this.env.temporaryRoots)) continue
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
    if (sorted.length === 0 && state.recordedAfterSeq < 0) return
    const event = this.session.append('workspace/changes', {
      turn: state.turn,
      files: sorted.slice(0, this.env.maxFiles),
      total: sorted.length,
      snapshot: { before, after },
    })
    state.recordedAfterSeq = event.seq
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
