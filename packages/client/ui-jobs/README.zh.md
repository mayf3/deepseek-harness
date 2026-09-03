---
description: "会话头部后台任务列表：可展开的流式输出面板、进行中/已结束分组，以及无保留输出的已结束任务的静态行。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-jobs

[English](README.md) | 中文

## 概述

`dsh-client-ui-jobs` 把本会话的后台任务放进一个头部控件。每一行都携带 `ctx.jobs` 保持最新的名册里该 job 的生命周期、跳动时长与模型可见的进度行或终态 detail；进行中的 job，或结算后仍留有保留输出的 job，额外提供可展开的面板，流式呈现其真实输出。收起即停流——只有有人在看时输出才流动。进行中的行以跳动时长为主行、kind 与状态为副行；已结束的行折叠在分组标题之后；没有保留输出的已结束 job（subagent，其回答已交给模型）渲染为静态行。

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

`ctx.jobs` 镜像的 `job.rows` 流是唯一名册：每个 `JobView` 行携带生命周期、时长、实时 `progress` 行或终态 `detail`，以及其保留字节数——进行中的 job，或留有保留输出的已结束 job，就是行可展开的依据。不存在需要 join 的第二份名册。

### 展开的面板

展开可观察的行会从 `ctx.jobs`（由 `dsh-api-job-controller` 安装）打开该 job 的输出观测流，注入内嵌终端面板。面板复制的是命令（不是输出），命令与输出行完整换行，输出在固定高度内滚动而非折叠，且不绘制自己的运行状态点——上方的行承载状态。保留缺口与流中断在面板上方渲染为提示。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

头部操作带里的一个 slot 条目（preset 标签之后、subagent 目录之前）渲染触发器与弹出层；弹出层通过测量锚点把自己收进视口。所有数据经 `ctx.jobs` 到达——组件不持有任何传输状态。名册跟随挂载：一个 `useEffect` 在控件存活期间保持会话的 `job.rows` 流打开。观测跟随可见性：另一个 `useEffect` 为展开行的 job 打开流，并在收起、卸载或弹出层关闭时关闭它。

| 文件 | 角色 |
|---|---|
| [`src/client/JobListAction.tsx`](src/client/JobListAction.tsx) | 任务列表：分组、时长、面板 |
| [`src/client/index.ts`](src/client/index.ts) | slot 注册与词典 |
| [`src/client/locales.ts`](src/client/locales.ts) | `job` 命名空间文案（zh 为事实源） |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-api-job-controller`](../../api/job-controller/README.zh.md) —— 行与面板背后的 `job.rows`、`job.observe` 流与 `ctx.jobs` 服务。
- [`dsh-jobs`](../../jobs/jobs/README.zh.md) —— 拥有环与投影语义的注册表契约。
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

- **没有 kill 控件**——取消仍归模型的 `job_kill`。
- **不渲染 channel 标签**——stdout 与 stderr 块拼接为一条流；按 channel 着色是展示层的后续工作。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作语境——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。本包只把 `ctx.jobs` 的名册与视图只读投影到一个 header slot，不发出 Cordis 事件，也不持有跨插件可变状态。
