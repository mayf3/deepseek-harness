# Agent Note: Process-table snapshots replace per-question inspector reads

Status: implemented

[English](2026-08-27-process-table-snapshots.md) | 中文

## Problem

一次终端就绪轮询要向平台问三个问题：shell 的子进程树、它的 POSIX 会话成员、以及每个被跟踪的子进程是否仍在运行。当每个问题各自去读一次进程表时，这次轮询的代价就随着当前命令派生出的子进程数量增长。

在 macOS 上每一次读取都是一次 `/bin/ps -axo` fork，并解析整张表——在实测主机上 795 个进程需要 14.33 ms。`LocalTerminalHandle.inspectForeground()` 读一次树，然后按每个被跟踪的子进程各问一次存活，所以 N 个子进程的一次轮询要读 N+1 次表。`dsh-terminal-bash` 每 50 ms 轮询一次、最长 30 s，而 `ProcessInspectorInternals.exec` 是 `execFileSync`，因此每次轮询在其整个时长内阻塞事件循环。

用生产环境的 `MacProcessInspector` 驱动真实进程树实测：

| 被跟踪的子进程数 | 一次轮询 | 占 50 ms 间隔的比例 |
|---|---|---|
| 0 | 18.0 ms | 36% |
| 1 | 33.8 ms | 68% |
| 2 | 49.1 ms | 98% |
| 5 | 87.1 ms | 174% |
| 10 | 178.4 ms | 357% |

任何派生两个及以上子进程的命令——一条管道、`make`、`pnpm`、`git`——都会把宿主事件循环打满，直到它退出。

拆卸路径的结构相同。`signalProcess` 自己去问存活来给每个信号加 PID 复用围栏，因此向 N 个成员发信号要读 N 次表。

## Decision

`ProcessInspector.snapshot()` 返回一个 `ProcessSnapshot`，即对进程表的一次观察，由它回答 `tree(rootPid)`、`session(sessionId)` 和 `alive(identity)`。它取代了那三个按问题划分的方法；检查器剩下的接口是 `foregroundPgid`、`isStdinWaiting`、`signalGroup` 和 `signalProcess`。

每个调用方捕获一次快照，并从中回答本次流程的全部问题。`LocalTerminalHandle.descendants()` 取一次快照，从中读取树与会话，并用同一个 `alive` 过滤幸存者，因此一次就绪轮询无论有多少子进程都只读一次表。`waitForMembers` 每一轮轮询各捕获一次新快照，因为它的用途正是观察变化。

`signalProcess(identity, signal, observed)` 接收调用方的观察，而不是自己去读表。PID 复用围栏保留，而 `signalMembers` 现在为整轮信号只捕获一次，而不是每个成员各一次。把观察显式传入正是 Linux 拆卸不退化的原因：那里的 `alive` 由快照已经付过代价的一次 `/proc` 遍历回答，而不是每个成员各遍历一次。

平台差异体现在快照如何构建，而不在它承诺什么：

- **macOS** 由一张 `ps` 表构建。该表既不暴露会话 id 也不暴露状态列，所以 `session` 为空，`alive` 报告的是「存在且起始标识匹配」。
- **Linux** 遍历一次 `/proc`，携带每个条目的父进程、起始标识、会话与状态。`alive` 把 `Z`、`X`、`x` 状态视为静止，与按 pid 读 `stat` 的判定一致。
- **Windows** 捕获 Toolhelp32 枚举供 `tree` 使用，没有 POSIX 会话，并且从活的进程句柄回答 `alive`，因为等待状态在那里不是表的一列。

`PosixProcessSnapshot` 同时承载两种 POSIX 形态：当平台的表省略某字段时，该行的 `session` 与 `state` 为 `undefined`，这使得 macOS 的答案从共享实现中自然得出，而不必新增一个类。

## Testing

`packages/subprocess/subprocess-local/tests/terminal.spec.ts` 通过注入的 `exec` 驱动真实的 `MacProcessInspector`，断言一次前台检查在 0、2、10 个子进程下都恰好执行一次 `-axo` 表读取。这个次数——而非墙钟时间——才是持久不变量：它在任何主机上都成立，并且在任何调用方按成员重复读表的那一刻失败。

## Alternatives considered

**只加一个批量的 `aliveMembers(members)`，其余方法不动。** 这能合并按成员的读取，改动也小得多，但树的读取仍然独立，因此 macOS 上一次轮询仍要 fork 两次 `ps` 外加 `tpgid` 读取——10 个子进程时约 32 ms，仍占 50 ms 间隔的 64%。事件循环依旧大部分时间被阻塞，实测到的问题在修复之后依然存在。

**在 `MacProcessInspector` 内部用短 TTL 缓存 macOS 的表。** 这不需要改接口，但它让陈旧性不可见：调用方无法分辨一个存活答案来自此刻还是来自上一次轮询结束时，而基于陈旧行发出的信号正是 PID 复用围栏要防止的事情。隐式缓存也与仓库偏好显式默认与显式边界的立场冲突。

**在 `snapshot()` 旁保留 `isAlive`。** 这样不必改动发信号的调用点，代价是同一个问题有两种问法，而其中只有一种在循环里是廉价的。这种不对称将不得不在每个调用点重新解释一遍。

**把 `exec` 改成异步，而不是减少读取次数。** 异步的 `execFile` 能让轮询不再阻塞事件循环，但每次轮询仍然 fork N+1 个进程；在繁忙的机器上这是把一次停顿换成了持续的 fork 压力。它在减少读取次数之上仍是值得做的后续项，而不是它的替代。

## Consequences

一次就绪轮询的进程表代价现在与子进程数量无关。在 macOS 上，一次轮询执行一次完整表读取加一次小的 `tpgid` 读取，也就是上表中 0 子进程那一行的代价，对任意子进程数量都成立。

Linux 上查询单个标识的存活，代价从读一个 `stat` 文件变成一次完整的 `/proc` 遍历。每个要查询多个标识的调用方都会把这次遍历摊薄，这正是 `signalProcess` 接收观察而非自行捕获的原因；将来若有调用方确实只需要一次孤立的存活查询，它付出的代价会比过去高。

快照是一个时间点视图，该类型的文档也这样声明。跨 `await` 持有一份快照再据此发信号，会扩大围栏本来要收窄的 PID 复用窗口；`waitForMembers` 每轮重新捕获正是为此。

每个 `ProcessInspector` 实现与测试替身都采用新形态，包括 Windows 检查器和 `dsh-terminal-bash` 的会话替身。此前通过替换 `processTree`、`processSession` 或 `isAlive` 来编排扫描的测试替身，现在替换对应的按问题读取钩子，其编排行为与调用计数保持不变。

同步的 `execFileSync` 边界与固定的 50 ms 轮询间隔未做改动；两者都仍是同一条就绪路径上待办的后续项。
