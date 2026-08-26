---
description: "内存 activity 注册表：可配置的环形缓冲留存（retainBytes、settledRetainBytes）、跨淘汰的绝对偏移、按 owner 作用域的清理，以及实时输出观察的分层监听器投递。"
kind: "package-reference"
---

# @deepseek-ai/dsh-activity-local

[English](README.md) | 中文

## 概述

`dsh-activity-local` 让 `ctx.activities` 落地：挂载它的一行后，每个生产者的实时输出保留在有界的进程内环里，读者以绝对字节偏移寻址，拿到的是新鲜快照与 chunk 拷贝——从不是活状态。留存按部署可配置，记录比生产者 fiber 活得久，owner 释放只清理被释放会话的行。为本仓库交付的单 Host web 部署选择它；持久或跨进程观察需要别的 provider。

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

在 `dsh-agent` 旁挂载一行 `cordis.yml`（`name: '@deepseek-ai/dsh-activity-local'`）；生产者与消费者随即以 `ctx.activities` 触达注册表。

### 留存

每个 activity 保留一个偏移跨淘汰仍绝对的 chunk 环：丢弃头部会前移 `outputEarliest`，单个超过活跃上限的 chunk 只保留 UTF-8 安全的尾部并带 `gapBefore` 标记。结算把环裁到 settled 上限，让完成的 activity 仍展示尾部而不占活跃预算。

| 配置 | 默认 | 含义 |
|---|---|---|
| `retainBytes` | `262144` | 每个 activity 的活跃输出留存，UTF-8 字节。 |
| `settledRetainBytes` | `16384` | activity 结算后保留的留存量。 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-activity-local)是每个可接受字段的穷尽来源。

### 生命周期

记录比生产者 fiber 活得久。owner 的第一个 activity 在确切的 `Agent` 作用域上挂一个清理；owner 释放会终结仍开放的记录（`killed`、`owner disposed`）并移除它们、announce 该移除。服务释放终结一切、清空存储并 announce 每个被清空的 owner。两者都不等待生产者——注册表不拥有任何执行资源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

一个进程级 `LocalActivityRegistry` 维护被跟踪记录的 map，每条持有自己的 chunk 环与游标事实。监听器按注册作用域分层，与 jobs 注册表完全一致，投递在单实例内保持 owner 相对，且每个监听器都被包住。裁剪按整 chunk 走，只对单个超大 chunk 在 UTF-8 边界上做尾部截取。

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | 注册表：环、留存、栅栏、作用域监听层、释放 |
| [`src/invariant.ts`](src/invariant.ts) | 包不变式伴生 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-activity`](../activity/README.zh.md)——本 provider 实现的契约。
- [docs/subsystems/activity.md](../../../docs/subsystems/activity.zh.md)——偏移、留存与投递的单一参考。
- [`dsh-api-activity-controller`](../../api/activity-controller/README.zh.md)——读取本注册表的 Remote 流。

-----

<a id="model-experience"></a>
## 模型体验

无：provider 只存储与提供观察状态；模型可见表面全部归生产者所有。

#### KV Cache 影响

无；本包从不组装或改动 provider 请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明该 provider 何时不合适。它们是当前包约束，不是任务积压。

- **无主桶没有准入上限**——有主生产者已受 jobs 准入策略约束，但打开大量无主 activity 的插件会让存储一直增长到服务释放。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
