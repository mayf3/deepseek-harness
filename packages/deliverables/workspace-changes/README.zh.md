---
description: "用 git 工作树快照汇总每个顶层轮次改动的文件，以 workspace/changes Session 事件宣告，并在 Session 存活期间提供摘要；配置、仓库要求与覆盖规则。"
kind: "package-reference"
---

# @deepseek-ai/dsh-workspace-changes

[English](README.md) | 中文

## 概述

本插件汇总每个顶层轮次改动了哪些文件、每个文件的增删行数：比较轮次开始和结束时的 git 工作树快照，再补上 git 覆盖不到的文件工具编辑。不在 git 仓库内或没有 git 时，摘要只列文件工具的编辑。Session 日志只收到一条写明轮号的 `workspace/changes` 事件；摘要留在 Host 上，通过 `workspaceChanges` 服务提供，直到 Session 释放。Web 的改动文件卡片渲染它；模型看不到它。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

正式提供的 Web bundle 挂载本插件。任何具备 `subprocess` 能力且 Host 上有 git 可执行文件的组合都可以挂载它：

```yaml
- name: '@deepseek-ai/dsh-workspace-changes'
  config:
    maxFiles: 500
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `timeoutMs` | `30000` | 单条 git 命令允许运行的毫秒数，超时则放弃本轮记录 |
| `outputMaxBytes` | `8388608` | 每条命令保留的 git 输出字节数，diff 列表更大时放弃本轮记录 |
| `maxFiles` | `500` | 单份摘要携带的最大文件数；`total` 仍报告完整数量 |

有工作目录且不是子代理来源的 Session 都会被记录；子代理 Session 不记录。快照通过私有 index 写入 Session 自己拥有的临时对象目录，仓库自己的对象库以只读 alternate 的方式挂接；仓库的 index、对象、工作树和 ref 保持不变，用户此前未提交的改动也不会进入摘要。Session 释放时删除该目录。工作目录内的嵌套仓库和 submodule 记录为 gitlink，其内部改动不会出现。不在任何 git 仓库内的工作目录不做快照。没有 git 时——或者 macOS 上只有 `/usr/bin/git` 的开发者工具桩程序时——同样定位不到仓库，插件记录一次日志。两种情况下摘要都只列下文所述的文件工具编辑，并以工作目录作为工作区；shell 的改动不会出现。

文件工具改动但快照覆盖不到的文件，由这些工具随结果持久化的 hunk 补入，结果没有持久化 hunk 时则取调用自身的参数，也就是新建文件的 `write` 和 `str_replace_editor` 的每一种修改：匹配忽略模式的文件，以及仓库之外的文件。`/tmp` 与平台临时目录下的文件被排除，除非它们位于仓库内。这些文件的行数按记录的 hunk 累加，因此同一轮内对一个文件的重复编辑可能把一行计算多次。快照覆盖范围之外通过 shell 命令做出的改动不会被记录。

每个文件携带持久的 `path`——位于工作目录内时为相对路径，否则为绝对路径——以及用于排序和标签的 `display` 路径：相对路径，仓库内位于工作目录之上的文件为 `../` 路径，家目录下的文件为 `~` 路径，其余为绝对路径。文件按 `display` 的码元顺序排序，因此上级路径和绝对路径排在工作目录自身文件之前。`workspace/changes` 事件只携带轮号；`ctx.workspaceChanges.summary(sessionId, seq)` 返回该序号的事件宣告的摘要，Session 已释放或本 Host 进程从未记录时返回 undefined。因此 Host 重启后重新打开的对话，先前轮次没有卡片。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

每个 Session 一个 `TurnRecorder`，串行化其 git 工作。`turn/start` 排入基线：`rev-parse` 每个 Session 只定位一次仓库并创建 Session 的临时对象目录，然后以仓库 index 为种子在临时 index 上执行 `add --all --ignore-errors` 与 `write-tree` 得到 tree id；不可读的文件被跳过并以 git 的退出码 1 报告，快照接受这个退出码。每轮持有自己的状态对象，因此被中断的轮次仍在运行的记录会在下一轮开始后保留自己那一轮的文件。每条命令都带 `GIT_OBJECT_DIRECTORY` 指向临时目录、`GIT_ALTERNATE_OBJECT_DIRECTORIES` 指向仓库的 objects，因此已提交内容从仓库读取，新对象不会落进仓库。每次 `tools/pre-execute` 都等待该队列，因此没有修改能先于其基线发生。`tool/call` 事件保留每个修改调用由参数推出的 hunk，`tool/result` 事件收集持久化的 hunk，后者优先。`agent/turn-stopping` 在轮内记录：第二次快照、两棵树之间的 `diff-tree -r -M --numstat`、对工作树内 hunk 路径的 `check-ignore`、追加事件，以及按事件序号保存摘要。`turn/end` 仅在最后一次记录尝试之后仍有工具结果结束时再次记录，这覆盖了中止、失败和被转向的轮次，且不会重复一次失败的尝试；早先记录之后的空列表会取代它。仓库的 index 只读取。

git 通过 `subprocess` 能力运行，使用净化后的环境、`GIT_TERMINAL_PROMPT=0`、`GIT_OPTIONAL_LOCKS=0`、配置的超时与有界输出。任何步骤失败都会放弃本轮记录并给出警告；下一轮重新开始。Session 释放与插件释放会中止排队的工作、忘记摘要并删除临时目录。

**运行时不变式：** 不发布伴生入口。事件监听归 effect 所有，记录器在其 Session 存活期间同时拥有摘要与快照树；没有独立观察会与它们分歧。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Web 产出物](../../client/ui-deliverables/README.zh.md)——读取所提供摘要并打开其文件的改动文件卡片。
- [子进程能力](../../subprocess/README.zh.md)——git 运行所经过的接缝。
- [本轮改动文件卡片决策](../../../.agents/notes/implemented/feature/2026-09-11-turn-changed-files-card.zh.md)——快照设计、覆盖规则、暂缓的影子仓库与被否决的备选方案。

<a id="model-experience"></a>
## 模型体验

无，因为记录器只追加一条仅写日志、只有客户端读取的 `workspace/changes` 事件，不注册任何面向模型的内容。

#### KV Cache 影响

这里的内容不会进入模型请求，因此不影响提供方缓存复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 摘要与快照树只在本 Host 进程内随其 Session 存活；Host 重启后重新打开的对话，先前轮次没有卡片。这是既定行为：Host 已经打不开内容的卡片不显示。
- 有两个 git 功能在快照期间仍会写入仓库自己的 git 目录：`core.splitIndex` 会写 `sharedindex.*` 文件，git-lfs 会对改动文件运行 clean 过滤器并把对象存到 `.git/lfs` 下。
- 需要 git 2.13 或更高版本以支持 `rev-parse --absolute-git-dir`；不支持的仓库格式或其他 git 失败会带着警告放弃本轮，而不是被当成普通目录。
- Session 的首次快照会把工作树里所有未跟踪且未被忽略的文件写进 Session 的临时目录；没有 `.gitignore` 却带着大体积构建产物的仓库，在 Session 释放前会占用同等的临时空间。
- 用户在轮次进行中自己做的编辑会被算到该轮。
- 不在任何 git 仓库内的工作目录只列文件工具的编辑，卡片里因此没有 shell 改动；Harness home 下的影子仓库暂缓，直到其排除规则能可靠地代替缺失的 `.gitignore`。
- 快照覆盖范围之外的文件按 hunk 累加计数，不是首尾对比，且只覆盖文件工具。
- Windows 路径在 `path` 中保留原生分隔符；`display` 始终用斜杠分隔。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
