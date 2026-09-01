---
description: "会话头部后台任务列表：可展开的流式 record 面板、进行中/已结束分组，以及无 record 任务的静态行。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-jobs

[English](README.md) | 中文

## 概述

`dsh-client-ui-jobs` 把本会话的后台任务放进一个头部控件。每一行都携带 `jobsBySession` 镜像里该 job 的生命周期、跳动时长与模型可见的 `detail`；声明了观测 record 的 job 额外提供可展开的面板，在运行期间流式呈现其真实输出。收起即停流——只有有人在看时输出才流动。进行中的行以跳动时长为主行、kind 与状态为副行；已结束的行折叠在分组标题之后；没有 record 的 job（subagent 委托、PTY 发送）渲染为无展开操作的静态行。

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

通过 web-app 清单加载本插件；在会话看得到至少一个 job 之前它不渲染任何东西，因此普通对话不会为未使用的能力长出控件。

### 一 job 一行

session control 流的 `jobsBySession` 镜像是唯一名册：每个 `SessionJob` 行携带生命周期、时长与模型可见的 `detail`，其 `outputTotal` 字段恰在 job 声明了 record 时存在——这个存在性就是行可展开的依据。不存在需要 join 的第二份名册。

### 展开的面板

展开可观察的行会从 `ctx.jobOutput` 打开该 job 的 record 观测流，注入内嵌终端面板。面板复制的是命令（不是输出），命令与输出行完整换行，输出在固定高度内滚动而非折叠，且不绘制自己的运行状态点——上方的行承载状态。保留缺口与流中断在面板上方渲染为提示。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

头部操作带里的一个 slot 条目（preset 标签之后、subagent 目录之前）渲染触发器与弹出层；弹出层通过测量锚点把自己收进视口。所有数据经 `ctx.jobOutput` 与标准 `useSessions` hook 到达——组件不持有任何传输状态。观测跟随可见性：一个 `useEffect` 为展开行的 job 打开流，并在收起、卸载或弹出层关闭时关闭它。

| 文件 | 角色 |
|---|---|
| [`src/client/JobListAction.tsx`](src/client/JobListAction.tsx) | 任务列表：分组、时长、面板 |
| [`src/client/index.ts`](src/client/index.ts) | slot 注册与词典 |
| [`src/client/locales.ts`](src/client/locales.ts) | `job` 命名空间文案（zh 为事实源） |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-api-session-controller`](../../api/session-controller/README.zh.md) —— 面板背后的 `jobsBySession` 镜像与 `session.observeJob` 流。
- [`dsh-jobs`](../../jobs/jobs/README.zh.md) —— 拥有 record 语义的注册表契约。
- [`dsh-client-ui-primitives`](../ui-primitives/README.zh.md) —— 面板所配置的 `TerminalBlock` 表面。

-----

<a id="model-experience"></a>
## 模型体验

无。本包为人类渲染宿主观测到的状态与实时输出，不触碰任何提示词、消息、schema、流或工具结果。模型对同一工作的视图仍在 [`dsh-tool-jobs`](../../jobs/tool-jobs/README.zh.md)。

#### KV 缓存影响

无；本包从不组装或发送 provider 请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定当前包约束，不是任务清单。

- **没有 kill 控件**——取消仍归模型的 `job_kill`；人工 kill 卡在 [web 任务显示 Agent Note](../../../.agents/notes/implemented/feature/2026-08-08-web-background-job-display.zh.md) 记录的 jobs `reported` 契约问题上。
- **不渲染 channel 标签**——stdout 与 stderr 块拼接为一条流；按 channel 着色是展示层的后续工作。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作语境——点击展开</summary>

无。

</details>
