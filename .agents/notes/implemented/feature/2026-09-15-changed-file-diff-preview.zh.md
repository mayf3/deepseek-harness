# Agent Note: 改动文件对比 tab

Status: implemented

[English](2026-09-15-changed-file-diff-preview.md) | 中文

## Problem

[改动文件卡片](2026-09-11-turn-changed-files-card.zh.md)告诉用户一轮改了哪些文件、改了多少行，但没说改了什么。点一行打开的是文件当前内容，在 Sidebar 里或在桌面应用里，既看不到本轮的编辑，也看不到编辑前的状态。git 覆盖不到的文件——被忽略的文件、仓库之外的文件，以及没有仓库的工作目录里的每一次文件工具编辑——只有文件工具随结果持久化的 hunk：上下文不完整，行数按重复编辑累加，完全没有整文件对比。

## Decision

卡片的每一行在右侧 Sidebar 打开一个 `changes-diff` tab，对比该文件在轮次开始与结束时的内容。Host 侧的 [workspace-changes](../../../../packages/deliverables/workspace-changes/README.zh.md) 记录器通过 `workspaceChanges.diff(sessionId, seq, index, signal)` 提供对比；[产出物插件](../../../../packages/client/ui-deliverables/README.zh.md)注册该 tab 类型，用当前查看的 Session、宣告事件的序号和文件下标给它定址，并通过经过认证的路由读取对比。有没有 Host 桌面，行都打开对比；有桌面时 tab 头部提供用默认应用打开，先前行级别的原生打开移到那里，卡片只保留一种行为。

git 覆盖不到的文件按 Codex 的 turn diff tracker 对比其 `apply_patch` 编辑的方式对比：用整文件副本，不用 hunk。在 `write`、`edit` 或有修改作用的 `str_replace_editor` 调用运行之前，记录器本来就要等待基线快照的 `tools/pre-execute` 步骤把所指文件复制到 Session 临时目录里快照对象旁边，每轮每个路径一次；轮次结束时再复制一次该路径。副本按其字节的 SHA-1 命名，相同内容只存一份，且不需要 git。快照覆盖到的路径保留 git 的行数；其余每个被捕获的路径由两份副本的逐行对比列出，反复编辑的行只计一次，文件工具编辑之后的 shell 改动也包含在内。记录器不再读取持久化的 hunk 和由参数推出的 hunk。

两个上限让副本和对比保持小。`maxFileBytes` 限制副本和为对比而读出的快照 blob；更大的文件列出时带 `oversized`，没有行数，其对比被拒绝，整文件副本因此负担得起。`diffTimeoutMs` 限制逐行对比，与 Codex 一样是 100 毫秒；超时后退化为一个替换全部行的 hunk，标记 `coarse`，因此病态的文件从不会拖住本轮记录或 tab。两者都是 Config 字段。

对比在被请求时在 Host 上计算，来源是保存在所提供摘要旁边的两侧内容来源：快照树中的路径，用 `ls-tree -l` 和 `cat-file blob` 在字节上限之内读出；或者从磁盘读取的副本。git 报告为二进制的快照一侧和含 NUL 字节的副本不提供行。tab 渲染带旧新行号的 hunk，没有语法高亮；Host 已不再提供的对比、读取失败、二进制文件和过大的文件各显示一行。

内容仍然只在本 Host 进程内随 Session 存活，这是卡片决定已经定下的；对比与卡片同寿命，因此 Host 重启后重新打开的对话两者都没有。

## Alternatives considered

**把整文件的前后文本放进文件工具的结果元数据**，像 Codex 的 `apply_patch` 返回的那样，会把每个被编辑的文件两次写进 Session 日志。记录器改为自己捕获文件，日志继续只携带轮号。

**把副本存在内存里**，像 Codex 的每轮 tracker 那样，会随每一轮增长，因为记录要活到 Session 结束；副本放到 Session 临时目录里快照对象旁边，只在请求对比时读取。

**把副本存为私有对象库里的 git blob** 能和快照共用一条读取路径，但会让文件工具这条路径依赖 git，而没有仓库或没有 git 的工作目录给不了它；同一目录下的普通文件让这条路径与 git 无关。

**给仓库之外的工作目录建影子仓库**仍然推迟；副本已经覆盖那里的文件工具编辑，这是用户能采取行动的部分。

**tab 里的语法高亮和左右对照视图**推迟到纯 unified 视图被证明不够用时再做。

**保留行打开当前文件**会让对比多一次点击才能到达；当前文件仍可从正文链接和文件 tab 打开。

## Consequences

每次文件工具编辑在 Host 上每轮读写一次整个文件，受 `maxFileBytes` 限制，即使快照也覆盖该路径；Session 的临时目录保存副本直到释放。未覆盖文件的对比行数是首尾对比，不是累加；两侧都超过上限的文件列为 `oversized` 而不是丢掉，因为没读过的内容永远不能认定为没有改动。一次对比最多花费两次 `ls-tree`、两次 `cat-file` 和一次有界的逐行对比；超时的对比携带两侧的全部行，最多两倍 `maxFileBytes`，tab 最多绘制其中 5000 行。对比路由会把所列文件在 Host 上记录时的完整文本送到浏览器，包括被忽略的文件、工作目录之上的仓库文件和工作区外的文件，而摘要路由只送路径和行数，Sidebar 的文件预览也限定在工作区根目录之内；这些编辑是用户授权的，因此接受这一点，并记入两个 README。

`WorkspaceChangedFile` 类型新增 `oversized`，`WorkspaceChanges` 新增 `diff`，两个提供给客户端的类型 `WorkspaceDiffHunk` 和 `WorkspaceFileDiff` 加入子系统页面。Session 日志不变。改动文件卡片的行在两种语言里都标为打开该文件的改动，因此录制的 Web 场景的黄金文件变了；同一场景现在会从快照打开一个 shell 追加过的文件的对比，从副本打开一个被忽略文件的对比。

聚焦测试覆盖整文件捕获的分类、超时退化、从快照树提供的对比、改名、删除的文件、过大的 blob 和副本、对比路由、tab 的地址、store 与各状态，以及卡片行的接线。
