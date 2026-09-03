---
description: "Host 与 Client 的 job 控制：把一个后台任务的输出 record 流式送到浏览器，不触碰模型的消耗型游标，并替人停止一个 job。"
kind: "package-reference"
---
# Job Controller

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-api-job-controller` 拥有 Host 的 `ctx.jobController` 服务与生成的 Client `ctx.remote.job` namespace。它的 Remote 流 `job.observe` 从绝对字节偏移发送声明了 record 的 job 的保留输出，Remote `job.kill` 替人停止一个 job；Client 半侧安装 `ctx.jobOutput`——按 job 引用计数的观测与 kill 服务，会话头部任务列表渲染其累积视图。名册不在这里：`SessionJob` 行仍随 [`dsh-api-session-controller`](../session-controller/README.zh.md) 拥有的会话控制流到达，行上的 `record` 说明本控制器是否有东西可流。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Host 控制器要求活体 Agent 注册表与 job 注册表（已发布组合里是 `dsh-jobs-local`），缺少任一则不加载。`job.observe({ sessionId?, jobId, from? })` 由请求的 session 解析围栏读取者——无主 job 不需要 session——先产出一个 `opened` 锚帧，再是聚合的 `output` 帧，job 结算且 record 排干后产出一个终态 `status`，随后流正常关闭。record 读取是非消耗的：模型侧 `job_output` 游标与完成播报状态永远观察不到它们。session 不拥有的 job、没有 record 的 job 或未知 job 会拒绝该流。重连方把上一帧的 `next` 作为 `from` 续读；低于最老保留字节的 `from` 得到带 `lossy` 的首帧而非错误。

`job.kill({ sessionId, jobId })` 以 `cancelled by the user` 为理由取消一个 job，并把终态报告留给 owner 不予认领，因此拥有它的 agent 的完成播报仍然待发；它回答 `{ outcome: 'requested' }` 或 `{ outcome: 'already-finished' }`，未知或他人的 job 以 `job/not-found` 拒绝，subagent 拥有的活体 session 适用 Session Controller 的所有权栅栏（`session/agent-busy`）。

Client 入口在 `ClientJobOutputModel` 之上提供 `ClientJobOutput`（`ctx.jobOutput`）。`kill(sessionId, jobId)` 转发到 `job.kill` 并把 Remote 结果原样交给调用方判定是否受理。`observe(sessionId, jobId)` 不论多少查看器展开同一 job 都只开一条 Gateway 流，按 job 保留有界的渲染尾部并用 `gapBefore` 标记淘汰或续读缺口，把终态或流失败记到视图上，最后一个查看器释放后丢弃视图。插件在自己的上下文仍是当前上下文时解析 Gateway 流工厂与 `job` namespace，因为观测的（重）开启跑在未声明 `remote.job` 的调用栈上。

### 配置

| 字段 | 默认值 | 含义 |
|---|---:|---|
| `observeFlushMs` | `100` | 新 record 输出到一次观测读取之间的聚合窗口，毫秒 |
| `observeMaxFrameBytes` | `65,536` | 每个观测输出帧的软字节预算；更大的单块整块发送 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-api-job-controller)是所有受支持字段及其 JSDoc 的完整来源。

-----

<a id="model-experience"></a>
## 模型体验

无。job 观测是浏览器与 Host 的控制状态；它不注册任何提示词、工具或会话事件。模型对同一工作的视图仍在 [`dsh-tool-jobs`](../../jobs/tool-jobs/README.zh.md)。

#### KV 缓存影响

无直接影响；观测读取从不触碰模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- record 是尽力而为的实时预览，不是终端转录：生产者按轮询轮次复制 stdout 与 stderr，同一轮询窗口内两条流的写入先 stdout 后到达 record，客户端拼接 chunk 时也不区分 `channel`。
- 流是进程本地的：Host 重启丢失全部 record，续读的观测随后锚定在空注册表上。
- 按 session 的围栏由注册表读取强制；Remote 层本身服务任何已连接浏览器，与会话控制流对 `jobsBySession` 的广播一致。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。控制器是 `ctx.jobs` 读取的无状态投影；本流转发的偏移关系由注册表自己的 `@deepseek-ai/dsh-jobs/invariant` 拥有。
