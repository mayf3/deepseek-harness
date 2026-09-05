---
description: "Host 与 Client 的 job 流：把一个会话看得到的名册与一个 job 的保留输出镜像到浏览器，不触碰模型的消耗型游标。"
kind: "package-reference"
---
# Job Controller

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-api-job-controller` 拥有 Host 的 `ctx.jobController` 服务与生成的 Client `ctx.remote.job` namespace。它的两条 Remote 流都是 `ctx.jobs` 的投影：`job.rows` 以整集帧镜像一个会话看得到的 job；`job.observe` 从绝对字节偏移发送一个 job 的保留输出。Client 半侧安装 `ctx.jobs`——按引用计数的服务，会话头部任务列表渲染其名册与累积视图。两条流都不触碰模型的消耗型游标与完成播报台账。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Host 控制器要求 job 注册表（已发布组合里是 `dsh-jobs-local`），缺少则不加载。`job.rows({ sessionId })` 产出该会话可见的集合——自己的 job 加上所有无主 job——打开时一次，之后每一轮聚合过的生命周期提交（注册、进度、停止中、结算、移除）后再一次；输出追加从不刷新名册，因为结算后的投影已经带着最终字节数。`job.observe({ sessionId?, jobId, from? })` 经 `forCaller(sessionId)` 读取——无主 job 不需要 session——先产出一个携带 job 投影的 `opened` 锚帧，再是聚合的 `output` 帧，job 结算且环排干后产出一个终态 `status`，随后流正常关闭；流中若通告了移除（拥有者 teardown），则以被移除 job 的终态投影收尾。两种读取都是非消耗的：模型侧 `job_output` 游标与完成播报状态永远观察不到它们。

Client 入口安装 `ctx.jobs`（`IJobs`），由包内部的 `ClientJobsModel` 支撑。`watchRows(sessionId)` 不论多少查看器持有都只为每个被关注的会话开一条名册流，最后一个释放后丢弃行；重连后的首帧已经是完整事实。`observe(sessionId, jobId)` 不论多少查看器展开同一 job 都只开一条 Gateway 流，按 job 保留有界的渲染尾部并用 `gapBefore` 标记淘汰或续读缺口，在终态帧上关闭视图或把流失败记到视图上，最后一个查看器释放后丢弃视图。插件在自己的上下文仍是当前上下文时解析 Gateway 流工厂与 `job` namespace，因为流的（重）开启跑在未声明 `remote.job` 的调用栈上。

### 配置

| 字段 | 默认值 | 含义 |
|---|---:|---|
| `observeFlushMs` | `100` | 注册表提交到下一次名册或输出读取之间的聚合窗口，毫秒 |
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

- 环是尽力而为的实时预览，不是终端转录：生产者的拉取源按轮询轮次复制，同一轮询窗口内两条流的写入先 stdout 落地，客户端拼接 chunk 时也不区分 `channel`。
- 两条流都是进程本地的：Host 重启丢失全部环与名册，续读的观测随后锚定在空注册表上，重开的名册从空开始。
- 按 session 的围栏由注册表的 `forCaller` 读取强制；Remote 层本身服务任何已连接浏览器。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。控制器是 `ctx.jobs` 读取的无状态投影；这些流转发的事件协议与事件对读取的关系由注册表自己的 `@deepseek-ai/dsh-jobs/invariant` 拥有。
