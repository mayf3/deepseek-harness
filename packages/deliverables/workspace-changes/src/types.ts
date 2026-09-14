/** Durable per-turn workspace change summaries and their Session event. */

/** One file changed during a turn, with line counts from git or from the recorded file-tool hunks. */
export interface WorkspaceChangedFile {
  /** Path relative to the Session working directory, or an absolute Host path outside it. */
  path: string
  /**
   * Sort key and label: the relative path inside the working directory, a
   * `../` path for repository files above it, a `~` path under the home
   * directory, otherwise the absolute path. Always slash-separated.
   */
  display: string
  /** Lines added; zero for a binary file. */
  added: number
  /** Lines deleted; zero for a binary file. */
  deleted: number
  /** Present when git reported the file as binary. */
  binary?: true
}

/** Files changed during one top-level turn. */
export interface WorkspaceChangesData {
  /** The turn whose file changes this summary describes. */
  turn: number
  /** Changed files in `display` order, capped at the plugin's `maxFiles`. */
  files: WorkspaceChangedFile[]
  /** Complete changed-file count, including files omitted by the cap. */
  total: number
  /** Git tree object ids of the turn-start and turn-end working-tree snapshots. */
  snapshot: { before: string; after: string }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Files changed by a completed top-level turn; the latest event for one turn replaces earlier ones. */
    'workspace/changes': WorkspaceChangesData
  }
}
