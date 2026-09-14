# 产出物

[English](deliverables.md) | 中文

记录一轮交给用户的东西，由 [deliverables 包组](../../packages/deliverables/README.zh.md)拥有的两个只写日志的 Session 事件承载：模型通过 `present` 工具声明的文件，以及这一轮改动的文件，后者由轮开始和轮结束时的 git 工作树快照对比得出。事件只由客户端读取，Web [产出物插件](../../packages/client/ui-deliverables/README.zh.md)在轮末渲染两者。工具行为、快照机制和配置见 [`tool-present`](../../packages/deliverables/tool-present/README.zh.md) 与 [`workspace-changes`](../../packages/deliverables/workspace-changes/README.zh.md) 的包 README。

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

## `WorkspaceChangesData`：一轮的改动摘要

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

## 持久事件

`tool-present` 通过声明合并把 `deliverables/presented: { turn; callId; files: PresentedFile[] }` 加入 `SessionEventMap`，每次 `present` 的最终结果成功时追加一条。`workspace-changes` 合并 `workspace/changes: WorkspaceChangesData`，在顶层轮停止时追加；同一轮后来的事件替代先前的，客户端只保留最新一条。生成的[持久化目录](../persistence-catalog.zh.md#deliverablespresented--log-only)记录了两处声明位置。两个事件都不会进入模型请求。
