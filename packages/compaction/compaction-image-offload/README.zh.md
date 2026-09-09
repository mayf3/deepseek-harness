---
description: "面向组合 compaction 的部署的图片省略执行器说明：支持图片的路由以请求超出图片预算拒绝时会发生什么。"
kind: "package-reference"
---

# @deepseek-ai/dsh-compaction-image-offload

[English](README.md) | 中文

## 概述

当较早的图片超出模型路由的预算时，图片密集的会话仍可继续。本插件永久将这些图片替换为注明附件及其只读路径的文本，然后重试请求，不消耗提供方重试预算。后续请求在切换路由、恢复和回放时都保留这一选择。token 计量随替换更新，提供方缓存只能复用到第一条被修改的消息之前。

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

凡是运行 agent loop、带有支持图片的路由并挂了 token meter 的组合，都应挂载本插件，随附的 `dsh` 基础配置已经挂载。没有它，`IMAGE_OFFLOAD_REQUIRED` 失败会进入普通恢复并以错误结束该轮次。本插件没有配置：DeepSeek adapter 执行其 file 模式和内联回退预算，pi-ai adapter 执行其 base64 上限，各自上报需要省略的数量。

### 最小可用组合

```yaml
- name: '@deepseek-ai/dsh-compaction-image-offload'
```

### 你可以观察到什么

每次省略会为每个被替换节点追加一条携带该节点启发式 token 价格的 `compaction/prune` 事件，紧接着追加替换节点本身：原消息的 `user/message` 或 `tool/result` 副本，受影响的图片块标了 `offloaded: true`，`surfaceOp` 为 `replace`，`sourceEventSeqs` 指向原节点。原事件原封不动留在日志里。随后是重试的请求；表层变化后 loop 会像任何一次 compaction 之后一样记录新的 `request/header`。

### 失败与恢复

本插件只处理带 `offloadImages` 的 `IMAGE_OFFLOAD_REQUIRED` 失败。它按模型请求顺序遍历表层，跳过 assistant 节点和已经标记的图片，给指定数量的出现位置打标记。没有可省略的图片时在 `agent/request-error` waterfall 上委派下游，由下游恢复或普通的轮次错误处理。这次重试不占提供方重试预算，也不追加 `llm/retry` 事件。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

本插件是只有一个 `agent/request-error` 监听器的函数插件。`offloadOldestImages()` 遍历 `session.surface.nodes`，在 `user/message` 和 `tool/result` 节点（含嵌套工具结果）中给前 `offloadImages` 个保留的出现位置打标记，对每个有变化的节点先追加 `compaction/prune` 影子价格，再以 `surfaceOp: { op: 'replace' }` 追加带标记的副本。它复用 compaction seam 的事件和 session 的替换机制，没有为它改动 session 或 agent loop。

本包不发布运行时 invariant 伴生插件：Session 校验每次替换的表层元数据，`compaction/prune` 协议由 compaction seam 的伴生插件负责。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [以表层替换实现持久的图片 offload](../../../.agents/notes/implemented/architecture/2026-09-02-durable-image-offload.zh.md)——本执行器实现的决定及其替代的方案。
- [compaction seam](../compaction/README.zh.md)——`compaction/prune` 影子定价协议。
- [compaction-tool-result-pruner](../compaction-tool-result-pruner/README.zh.md)——用同一替换机制修剪工具输出的兄弟执行器。
- [dsh-llm](../../llm/llm/README.zh.md)——`ImageBlock.offloaded`、`IMAGE_OFFLOAD_REQUIRED` 与占位投影。
- [llm-deepseek 适配器](../../llm/llm-deepseek/README.zh.md)与 [llm-pi-ai 适配器](../../llm/llm-pi-ai/README.zh.md)——上报省略数量的路由预算。

-----

<a id="model-experience"></a>
## 模型体验

### 已省略的请求图片

#### 模型看到的内容

替换标记过的每个图片出现位置，以路由的占位文本（`offloadedImageText`）到达模型，文本注明附件及其只读路径而不是图片本身；未标记的出现位置仍是图片。该集合不会自行缩小，模型可以确信被省略的图片会一直被省略，再需要内容时通过路径读回。

#### Token 影响

被省略的出现位置只花费占位文本，不再花费视觉 token。token meter 按表层上的标记为被替换节点定价。

#### KV Cache 影响

一次替换把较早的图片换成占位文本，该请求的 provider 缓存复用因此止于第一条被替换的消息。替换永不回退，之后的前缀保持稳定。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **被省略的图片不会自动回归**——更大的预算、更大的路由或 compaction 降低总量都不会移除标记；恢复手段是占位文本中的只读路径。
- **每次省略都要先失败一次**——发送前没有任何规划，路由的拒绝就是信号，这和计划中改由 provider 报告无法缓存图片的方向一致。
- **临时的小预算会永久省略**——迫使内联回退的 Files 故障，或临时切到小预算路由，会省略后来的路由本可以发送的图片。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

本开发备注是非权威的工作背景：给维护者的备注和未决问题。已交付的行为与被接受的理由见上文各节、包代码和链接的 Agent Note。

- 产生 `IMAGE_OFFLOAD_REQUIRED` 的路由本地字节检查是过渡实现：provider 自己报告无法缓存的图片之后，adapter 把该报告换算成数量，本执行器保持不变。

</details>
