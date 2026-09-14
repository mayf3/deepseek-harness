# Deliverables

English | [中文](deliverables.zh.md)

What a turn hands to the user, recorded as two log-only Session events owned by the [deliverables package group](../../packages/deliverables/README.md): the files the model declared through the `present` tool, and the files the turn changed, summarized from git working-tree snapshots taken at turn start and turn end. Only clients read the events; the Web [deliverables plugin](../../packages/client/ui-deliverables/README.md) renders both at the end of the turn. Tool behavior, snapshot mechanics, and configuration are on the package READMEs for [`tool-present`](../../packages/deliverables/tool-present/README.md) and [`workspace-changes`](../../packages/deliverables/workspace-changes/README.md).

Sources: [`packages/deliverables/tool-present/src/types.ts`](../../packages/deliverables/tool-present/src/types.ts), [`packages/deliverables/workspace-changes/src/types.ts`](../../packages/deliverables/workspace-changes/src/types.ts)

## `PresentedFile` — one declared delivery

```ts type-equiv
/** A declared filesystem file whose current contents remain at its source path. */
interface PresentedFile {
  /** Original absolute path or path relative to the Session working directory. */
  path: string
  /** Optional description supplied by the model. */
  description?: string
}
```

## `WorkspaceChangedFile` — one changed file

```ts type-equiv
/** One file changed during a turn, with line counts from git or from the recorded file-tool hunks. */
interface WorkspaceChangedFile {
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
```

## `WorkspaceChangesData` — one turn's change summary

```ts type-equiv
/** Files changed during one top-level turn. */
interface WorkspaceChangesData {
  /** The turn whose file changes this summary describes. */
  turn: number
  /** Changed files in `display` order, capped at the plugin's `maxFiles`. */
  files: WorkspaceChangedFile[]
  /** Complete changed-file count, including files omitted by the cap. */
  total: number
  /** Git tree object ids of the turn-start and turn-end working-tree snapshots. */
  snapshot: { before: string; after: string }
}
```

## Durable events

`tool-present` declaration-merges `deliverables/presented: { turn; callId; files: PresentedFile[] }` into `SessionEventMap`, appended once per successful final `present` result. `workspace-changes` merges `workspace/changes: WorkspaceChangesData`, appended when a top-level turn stops; a later event for the same turn replaces the earlier one, so a client keeps only the latest. The generated [persistence catalog](../persistence-catalog.md#deliverablespresented--log-only) records both declaration sites. Neither event reaches the model.
