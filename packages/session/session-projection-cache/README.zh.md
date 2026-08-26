---
description: "面向部署方与维护者的持久会话投影缓存说明，用于选择、配置或排查持久检查点、零 I/O 列表读取与加速的冷投影折叠。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-projection-cache

[English](README.md) | 中文

## 概述

`dsh-session-projection-cache` 将每个已注册投影单元的状态存为 `session_projcache` 存储域 `per-record` 布局下的一份逐会话版本化文档。存储行是可丢弃的折叠捷径，绝不是权威：零 I/O 列表可以把它用作暂定 hint，但该行可能落后于日志，也可能越过后来崩溃修复形成的截断点。精确 prepared-session 读取会用调用方提供的完整日志校验缓存状态，并在行不再适用时重新折叠；缓存自身绝不读取会话持久化层。三个必写点——会话创建、`turn/end` 与会话释放——加上可配置的条数与间隔节流，使记录足够新，可用于列表预热与加速冷折叠。

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

当客户端应在不加载日志的情况下列出冷会话投影值时，把本包与投影注册表及存储栈一起挂载。没有它时，消费方必须先取得日志，才能重建冷投影值。

### 何时选择

当部署会重启会话，并需要为历史列表、统计信息或 goal 快照提供持久投影值时，选择本包。当投影只服务实时会话，或额外存储写入的成本高于所节省的投影工作时，跳过本包。

### 最小配置

两个节流字段均必填——写入节奏是部署选择，没有普适正确值：

缓存通过存储栈打开自己的域，因此 base 先挂 `storage`、`storage-json`（根 `dshHomePath('storages')`）与 `storage-domain`（`backend: json`）：

```yaml
- id: session-projection-cache
  name: '@deepseek-ai/dsh-session-projection-cache'
  config:
    writeEveryEvents: 200
    writeIntervalMs: 5000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `writeEveryEvents` | 必填 | 在各必写点之间强制一次持久检查点写入的每会话已提交事件数 |
| `writeIntervalMs` | 必填 | 各必写点之间脏检查点最长可保持未写入的时间 |

本插件注入 `storageDomain`、`sessionProjections` 与 `sessions`。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-session-projection-cache)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 检查点如何写入

三个必写点总是写入：会话创建保存由种子派生的切面，`turn/end` 保存列表读取所需的轮次终值，会话释放保存最终实时切面。其间，配置的条数与间隔节流随事件累积写入。每次写入通过领域写入链以原子方式替换该会话的完整记录；失败会记录警告并让缓存保持陈旧，后续写入会自行修复。

### 读取缓存值

`cachedSnapshot(meta)` 以零 I/O 从存储域一致的内存表同步提供客户端值。它只接受身份匹配的记录及版本和 schema 均匹配的客户端 key，再按所服务行的最低水位返回尽力而为的 `{ asOfSeq, values }` 切面；host-only 行会被省略。对于未知 id、无关生命周期、缺失或外来的记录文档，或没有可用行的情况，它返回 `undefined`。列表载体只把该值作为暂存 hint：成功的 follow opening 会精确替换它，再重放 opening 期间到达的 control 更新。普通 hint 与 live frame 继续按 higher-sequence-wins，replacement control baseline 可以截断超出其持久 cut 的行。

`coldSnapshot(meta, events)` 接受完整有序日志，只以该精确范围校验一次每条 seed row，从 `init(header)` 折叠所需事件，并在不访问持久化层的情况下刷新记录。`hydratePrepared(session, meta, events)` 为尚未发布的 prepared Session 执行生产精确读取校验；若缓存状态畸形或越界，只有该路径会在所提供的完整日志上从 `init(header)` 重试。持久事件流本身若已损坏，重试仍然失败，绝不会产出部分快照。

### 缓存保证什么

在检查点提交时，日志领先、缓存跟随：实时写入先把缓冲的 Session 事件持久化，再保存缓存行，因此该次写入不会提交到当时完整日志之外。后续崩溃修复仍可能把日志截断到现有行之前，所以纯缓存值始终只是暂定值，精确读取必须校验所提供的完整日志。读取和写入共享存储域一致的内存状态，而且只在持久化成功后才改变该状态。每条记录绑定 Session header 身份（`createdAt`、`cwd`），每一行都要经过版本与 schema 校验；无关或不可用的缓存数据会被丢弃，而不会迁移。JSON 后端把每条记录存于仅所有者可访问的 `<root>/session_projcache/sessions/<id>.json` 目录树中。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节说明缓存的持久性与存储所有权；可观察行为已在[使用本包](#use-this-package)中说明。

### 设计理念

缓存是投影注册表检查点接口上的折叠捷径，存于 `per-record` 领域数据表中。读取绝不绕过领域的一致内存；每次后台写入都 fail-soft；`ver` 不匹配时丢弃而不迁移记录；状态必须通过实时单元的 `stateSchema`；写入通过无损 JSON 边界替换一份完整 Session 记录；精确读取以调用方提供的完整日志为权威。

### 读写所有权

缓存在 `session_projcache` 领域中为每个 Session 保存一份带版本戳的文档。它不依赖会话持久化后端，不调用 `locate`，也不检查持久化目录。调用方负责精确读取日志，并把同一次读取得到的不可变 header 与完整事件交给缓存；缓存负责校验、重新折叠与 fail-soft 回写。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`SessionProjectionCache` 服务、写后监听器、缓存读取 |
| [`src/spec.ts`](src/spec.ts) | `session_projcache` 域 spec 与记录身份类型 |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴生插件（无运行时不变式；正确性在写入与读取路径强制） |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从缓存逐步进入它检查点化的注册表与保存其记录的存储域。

- [会话投影子系统](../../../docs/subsystems/session-projection.zh.md)——本缓存检查点化的投影单元约定与驱动语义。
- [会话投影注册表](../session-projection/README.zh.md)——本缓存持久化其检查点的 `ctx.sessionProjections` 服务。
- [存储子系统](../../../docs/subsystems/storage.zh.md)——保存缓存记录的领域路由与后端行为。
- [会话包映射](../README.zh.md)——相邻的持久化、标题与遥测包。
- [会话投影 RFC](../../../.agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.zh.md)——持久投影缓存的设计理由。

-----

<a id="model-experience"></a>
## 模型体验

无，因为持久缓存只加速主机侧的投影状态读取，不注册任何模型可见内容。

#### KV Cache 影响

无；缓存从不组装或发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明缓存何时需要运维注意。它们是当前包约束，不是任务积压。

- **无淘汰或保留接口**——记录按会话持续累积；清理已存储检查点属于带外维护，与会话持久化采用相同策略。
- **间隔节流采用按会话的粗粒度控制**——一次无脏数据的写入完成后，计时器在首个脏事件到达时启动；持续但低于条数阈值的事件流每间隔写入一次，而非滑动窗口。
- **零 I/O 值是尽力而为的**——缓存行可能落后于当前事件，也可能越过崩溃修复后的截断点；Host 精确读取会用完整日志校验，客户端则保留最高 sequence，直到后续值或 replacement control baseline 取代它。
- **冷日志由调用方提供**——缓存能校验并重新折叠一份完整日志，但绝不自行读取会话持久化层；需要精确冷快照的消费方负责该日志读取。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
