# Deliverables

English | [中文](deliverables.zh.md)

What a turn hands to the user, owned by the [deliverables package group](../../packages/deliverables/README.md): the files the model declared through the `present` tool, recorded in a log-only Session event, and the files the turn changed, summarized from git working-tree snapshots taken at turn start and turn end (or, outside a repository, from the file tools' persisted hunks alone), announced by a log-only event and served by a Host service while the Session lives. Only clients read them; the Web [deliverables plugin](../../packages/client/ui-deliverables/README.md) renders both at the end of the turn. Tool behavior, snapshot mechanics, and configuration are on the package READMEs for [`tool-present`](../../packages/deliverables/tool-present/README.md) and [`workspace-changes`](../../packages/deliverables/workspace-changes/README.md).

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

## `WorkspaceChangesSummary` — one turn's change summary

```ts type-equiv
/** Files changed during one top-level turn, kept on the Host until its Session is disposed. */
interface WorkspaceChangesSummary {
  /** The turn whose file changes this summary describes. */
  turn: number
  /** The Session working directory `path` values are relative to. */
  cwd: string
  /** Changed files in `display` order, capped at the plugin's `maxFiles`. */
  files: WorkspaceChangedFile[]
  /** Complete changed-file count, including files omitted by the cap. */
  total: number
  /** Lines added over every changed file, including files omitted by the cap. */
  added: number
  /** Lines deleted over every changed file, including files omitted by the cap. */
  deleted: number
  /** Git tree ids of the turn-start and turn-end snapshots; absent when no snapshot was taken. */
  snapshot?: { before: string; after: string }
}
```

## `WorkspaceChanges` — the Host service serving summaries

```ts type-equiv
/** Serves the summaries the recorder keeps for live Sessions. */
interface WorkspaceChanges {
  /**
   * The summary announced by one `workspace/changes` event.
   * @param sessionId - the Session that appended the event.
   * @param seq - the event's sequence number.
   * @returns the summary, or undefined once its Session was disposed or when this Host never recorded it.
   */
  summary(sessionId: SessionId, seq: number): WorkspaceChangesSummary | undefined
}
```

## Durable events and the served summary

`tool-present` declaration-merges `deliverables/presented: { turn; callId; files: PresentedFile[] }` into `SessionEventMap`, appended once per successful final `present` result. `workspace-changes` merges `workspace/changes: { turn }`, appended when a top-level turn stops; the summary that event announced is not in the log but is returned by `workspaceChanges.summary(sessionId, seq)` for the event's sequence until the Session is disposed, so a conversation reopened after a Host restart has no changed-files card for its earlier turns. A later event for the same turn replaces the earlier one, so a client keeps only the latest. The generated [persistence catalog](../persistence-catalog.md#deliverablespresented--log-only) records both declaration sites. Neither event reaches the model.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxworkspacechanges--workspacechanges"></a>

### `ctx.workspaceChanges` — `WorkspaceChanges`

Serves the summaries the recorder keeps for live Sessions.

```ts cordis-catalog
/**
 * The summary announced by one `workspace/changes` event.
 * @param sessionId - the Session that appended the event.
 * @param seq - the event's sequence number.
 * @returns the summary, or undefined once its Session was disposed or when this Host never recorded it.
 */
summary(sessionId: SessionId, seq: number): WorkspaceChangesSummary | undefined
```

Types: [SessionId](core.md)

Source: [`packages/deliverables/workspace-changes/src/types.ts`](../../packages/deliverables/workspace-changes/src/types.ts)
<!-- END GENERATED cordis-surface -->
