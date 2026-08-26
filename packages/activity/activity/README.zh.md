---
description: "流式输出观察契约（ctx.activities）：open/append/end 句柄、非消费偏移读取、owner 栅栏，以及供实时活动输出生产者与消费者共用的拉取泵。"
kind: "package-reference"
---

# @deepseek-ai/dsh-activity

[English](README.md) | 中文

## 概述

`dsh-activity` 让长时运行的生产者只发布一次实时输出与状态，任意数量的独立消费者读取它而不会偷走模型的字节：读取是非消费的，以跨淘汰仍有效的绝对 UTF-8 字节偏移寻址，并以归属会话为栅栏。注册表是纯观察面——它什么都不启动、什么都不取消、对模型不可见，因此生产者保留自己的执行资源与既有模型可见表面。本包只交付契约；加载 [`dsh-activity-local`](../activity-local/README.zh.md) 获得可用注册表，没有实现时 `ctx.activities` 不存在，观察静默退化为无。

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

编写镜像实时工作的生产者、或渲染它的消费者时使用本包；组合挂载的是实现行（`@deepseek-ai/dsh-activity-local`），从不直接挂载这个契约包。

### 生产一个 activity

`open(spec): ActivityHandle` 校验 kind、label 与确切的活跃 owner，然后原子注册记录并返回生产者面：同步的 `append(text, { channel?, gapBefore? })`、`updateDetail(detail)`，以及先到先赢的 `end(outcome)`。在 `end` 之后——包括 teardown 强制收尾——`append` 与 `updateDetail` 记日志后丢弃而非抛出，因此生产者的尾部 flush 不会破坏自己的 teardown。生产者插件以自己的不透明 id 命名空间扩展 `ActivityKindMap`，并可通过 `ActivityCorrelation` 把 activity 关联到其工具调用与后台 job。用 `ctx.get('activities')` 访问注册表并包住每个观察失败：该面是可选的，被观察的工作绝不能依赖它。

### 消费 activities

`get(id, caller?)` 与 `list(caller?)` 返回新鲜快照；列表只含调用方拥有与无主的 activity，可预测的 id 使该栅栏成为边界。`read(id, from, caller?)` 返回与 `[from, total)` 重叠的留存 chunk 加恢复偏移，不消费任何东西；读到最旧留存字节之前的位置得到 `lossy: true`，绝不报错。`onActivitiesChanged(listener)` 观察可见集变化，消费者据此重读而非累积增量；`onOutput(listener)` 以仅含 id 的信号提示流推进；两者按 owner 相对投递并包住每个监听器。

### 泵送一个底座

`pumpActivityOutput(handle, sources, { pollMs, done })` 是底座为非消费偏移读取器（subprocess 的 `readFrom(fromByte)` 家族）的生产者的共用泵：它以有界节奏复制带标签的增量，把有损的源读取标为 `gapBefore`，并在 `done` 结算后再排空一次，自己从不调用 `end()`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

本包持有抽象 `ActivityRegistry` 服务（直接挂载会抛出并指名应加载的实现）、词汇类型、branded `ActivityId`、泵与 invariant 伴生。偏移是绝对的，观察者的游标从不依赖其他观察者做了什么；淘汰只前移最旧留存字节——lossy 标志就是迟到读者得知头部已丢的方式。

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | 抽象 `ActivityRegistry` 服务与直接挂载防护 |
| [`src/types.ts`](src/types.ts) | 词汇：kind、快照、句柄、读取、监听器 |
| [`src/brand.ts`](src/brand.ts) | branded `ActivityId`（浏览器安全叶子） |
| [`src/pump.ts`](src/pump.ts) | `pumpActivityOutput` 拉取底座泵 |
| [`src/invariant.ts`](src/invariant.ts) | 装在变化流上的快照不变式 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-activity-local`](../activity-local/README.zh.md)——内存实现及其留存配置。
- [docs/subsystems/activity.md](../../../docs/subsystems/activity.zh.md)——子系统参考：偏移、留存、监听器投递。
- [`dsh-api-activity-controller`](../../api/activity-controller/README.zh.md)——把该面提供给浏览器的 Remote 流。
- [观察面 Agent Note](../../../.agents/notes/implemented/feature/2026-08-24-activity-observation-seam.zh.md)——该面为何是非消费且模型不可见的。

-----

<a id="model-experience"></a>
## 模型体验

无：注册表为人承载实时观察状态，不注册任何 prompt、工具或会话事件；activity 输出只经由生产者既有的工具结果与 `ctx.jobs` 读取才对模型可见。

#### KV Cache 影响

无；本包从不组装或改动 provider 请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明契约何时不合适。它们是当前包约束，不是任务积压。

- **记录是进程本地且仅存活期**——Host 重启清空所有 roster，而 transcript 保留生产方的工具卡片；持久回放是另一项设计。
- **观察面没有取消动词**——停止工作仍属于生产者与 `ctx.jobs`；面板发起的 kill 被 [web job display Agent Note](../../../.agents/notes/implemented/feature/2026-08-08-web-background-job-display.zh.md) 记录的 jobs `reported` 契约问题阻塞。
- **已结算记录存续到 owner 释放**——留存把它们的缓冲裁到 settled 上限，但行本身不会被老化清除。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
