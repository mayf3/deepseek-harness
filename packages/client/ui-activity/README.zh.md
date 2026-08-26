---
description: "会话头部任务列表：后台任务与其实时输出 activity 逐行合并、可展开的流式面板、进行中/已结束分组，以及无注册表时的优雅退化。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-activity

[English](README.md) | 中文

## 概述

`dsh-client-ui-activity` 把本会话正在跑的工作放进一个头部控件：后台任务与其关联的实时输出 activity 逐行合并，外加 workflow 运行等独立 activity。展开可观察的行，其真实输出在运行期间流入内嵌终端面板；收起即停流——只有有人在看时输出才流动。进行中的行以跳动时长为主行、kind 与状态为副行，已结束的行折叠在分组标题之后；没有 activity 注册表时 job 行照常渲染——控件退化为普通任务列表而不是消失。

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

经 web-app 清单加载该插件；会话一个任务都看不到时它完全不渲染，普通会话不会为未使用的能力多出控件。

### 逐行 join

jobs 与 activity 保持为两个独立的面（[缘由](../../../.agents/notes/implemented/feature/2026-08-24-activity-observation-seam.zh.md)）；合并逐行发生在本组件内。job 行保留来自 `jobsBySession` 镜像的生命周期、时长与模型可见 `detail`，当某个 activity 以 `correlation.jobId` 关联到它时获得可展开的输出面板；没有 job 的 activity 保留自己的行。没有可观察 activity 的行渲染为无展开交互的静态行。

运行中的 job 行还带一个两击式停止控件：首击武装、三秒内的确认击调用 `session.killJob`，行状态经 jobs 帧收敛（先 `stopping`，再入已结束分组）。该 kill 不认领终态报告，任务的 owner agent 因此照常收到标准完成通知——模型被明确告知用户停止了它的任务，而不是留给它去猜（[决策](../../../.agents/notes/implemented/feature/2026-08-26-human-job-kill.zh.md)）。

### 展开的面板

展开可观察的行即把该 activity 在 `ctx.activityFeed` 上的观察流打开进内嵌终端面板。面板的复制控件复制命令（而非输出），命令与输出行完整换行，输出在固定高度内滚动而非折叠，且不画自己的运行状态点——上方的行已携带状态。保留缺口与流失败以面板上方的提示呈现。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

头部操作区里的一个 slot 条目（preset 标签之后、subagent 目录之前）渲染触发器与弹层；弹层通过测量锚点把自己贴合进视口。所有数据经 `ctx.activityFeed` 与标准 `useSessions` 钩子到达——组件不持有任何传输状态。观察跟随可见性：一个 `useEffect` 为展开行的 activity 开流，在收起、卸载或弹层关闭时关流。

| 文件 | 角色 |
|---|---|
| [`src/client/ActivityListAction.tsx`](src/client/ActivityListAction.tsx) | 合并任务列表：join、分组、时长、面板 |
| [`src/client/index.ts`](src/client/index.ts) | slot 注册与词典 |
| [`src/client/locales.ts`](src/client/locales.ts) | `activity` 命名空间文案（zh 为真源） |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-api-activity-controller`](../../api/activity-controller/README.zh.md)——面板背后的 feed 服务与流。
- [统一任务列表 Agent Note](../../../.agents/notes/implemented/feature/2026-08-25-unified-task-list.zh.md)——join 为何住在 UI 投影层。
- [`dsh-client-ui-primitives`](../ui-primitives/README.zh.md)——面板所配置的 `TerminalBlock` 表面。

-----

<a id="model-experience"></a>
## 模型体验

无：本包只为人渲染宿主观察到的状态与实时输出，不触碰任何 prompt、消息、schema、流或工具结果。模型对同一工作的视图仍在 [`dsh-tool-jobs`](../../jobs/tool-jobs/README.zh.md)。

#### KV Cache 影响

无；本包从不组装或发送 provider 请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制是当前包约束，不是任务积压。

- **独立 activity 没有停止控件**——workflow 运行没有 job 句柄，取消只触达带 `jobId` 的行；要停 activity-only 的工作，先让其生产者注册 job。
- **不渲染通道标签**——stdout 与 stderr chunk 连接成一条流；分通道着色是后续呈现优化。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
