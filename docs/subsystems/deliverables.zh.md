# 产出物

[English](deliverables.md) | 中文

记录一轮交给用户的东西，由 [deliverables 包组](../../packages/deliverables/README.zh.md)拥有：模型通过 `present` 工具声明的文件，记在一个只写日志的 Session 事件里；这一轮改动的文件，由轮开始和轮结束时的 git 工作树快照对比得出（不在仓库内时只由文件工具持久化的 hunk 得出），用一个只写日志的事件宣告，并在 Session 存活期间由 Host 服务提供。它们只由客户端读取，Web [产出物插件](../../packages/client/ui-deliverables/README.zh.md)在轮末渲染两者。工具行为、快照机制和配置见 [`tool-present`](../../packages/deliverables/tool-present/README.zh.md) 与 [`workspace-changes`](../../packages/deliverables/workspace-changes/README.zh.md) 的包 README。

源码：[`packages/deliverables/tool-present/src/types.ts`](../../packages/deliverables/tool-present/src/types.ts)、[`packages/deliverables/workspace-changes/src/types.ts`](../../packages/deliverables/workspace-changes/src/types.ts)

## `PresentedFile`：一条声明的交付

```ts type-equiv
/** A declared filesystem file whose current contents remain at its source path. */
interface PresentedFile {
  /** Original absolute path or path relative to the Session working directory. */
  path: string
  /** Optional description supplied by the model. */
  description?: string
}
```

## `WorkspaceChangedFile`：一个改动的文件

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

## `WorkspaceChangesSummary`：一轮的改动摘要

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

## `WorkspaceChanges`：提供摘要的 Host 服务

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

## 持久事件与提供的摘要

`tool-present` 通过声明合并把 `deliverables/presented: { turn; callId; files: PresentedFile[] }` 加入 `SessionEventMap`，每次 `present` 的最终结果成功时追加一条。`workspace-changes` 合并 `workspace/changes: { turn }`，在顶层轮停止时追加；该事件宣告的摘要不在日志里，而是由 `workspaceChanges.summary(sessionId, seq)` 按事件序号返回，直到 Session 释放，因此 Host 重启后重新打开的对话，先前轮次没有改动文件卡片。同一轮后来的事件替代先前的，客户端只保留最新一条。生成的[持久化目录](../persistence-catalog.zh.md#deliverablespresented--log-only)记录了两处声明位置。两个事件都不会进入模型请求。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [SessionId](core.zh.md)

Source: [`packages/deliverables/workspace-changes/src/types.ts`](../../packages/deliverables/workspace-changes/src/types.ts)
<!-- END GENERATED cordis-surface -->
