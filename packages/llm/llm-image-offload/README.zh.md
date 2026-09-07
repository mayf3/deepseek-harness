---
description: "面向用户与维护者的图片省略插件说明：通过会话的持久 image/offload 水位，把请求图片控制在各路由预算之内。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-image-offload

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-llm-image-offload` 通过推进会话的持久 `image/offload` 水位，把请求图片控制在各路由的预算之内。step 进入前，它根据路由模型声明的请求图片预算和表层仍在发送的图片出现位置规划水位；adapter 以 `IMAGE_OFFLOAD_REQUIRED` 让一次尝试失败时，它按失败中给出的数量推进水位并重试该 step。水位只会前进，因此模型看到的图片和 provider 缓存前缀只向前移动，每个已发出请求的图片集合都仅由会话日志决定。

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

凡是运行 agent loop 且带有支持图片路由的组合，都应挂载本插件。没有它，支持图片的 adapter 在预算超出时会以 `IMAGE_OFFLOAD_REQUIRED` 让 step 失败，且没有任何恢复路径会推进水位。本插件没有配置：DeepSeek adapter 在其解析后的模型信息上以 `imageRequest` 声明 file 模式预算，pi-ai adapter 声明其 base64 上限。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-llm-image-offload'
```

### 你可以观察到什么

每次推进都是一个持久的 `image/offload` 事件，携带轮次、step 和水位：承载最后一个被省略出现位置的事件序号，以及它在内容中的块路径。step 前的推进落在 `turn/start` 之后、`step/start` 之前；由失败驱动的推进落在它所回应的 `assistant/attempt` 之后、重试请求之前。`session.imageOffloadWatermark()` 读取当前生效的水位，位于水位及之前的每个派生图片块都带有 `offloaded: true`，每条路由把它渲染为注明图片及其只读路径的占位文本。

### 失败与恢复

step 前的规划读取最新 `request/header` 所指的路由，覆盖的是 step 自己的消息追加之前的表层；第一个 header 之前、路由没有 adapter、路由未声明预算时都会跳过。规划看不到的出现位置，以及只有在序列化时才发现精确请求字节超出预算的出现位置，会经过一次失败的尝试到达模型：adapter 以 `IMAGE_OFFLOAD_REQUIRED` 和 `offloadImages` 失败，插件在 `agent/request-error` waterfall 上按该数量推进并返回 `retry` 动作。没有可省略的出现位置时插件向下游委托，失败因此进入下游恢复，否则结束该轮次。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

本插件是带两个监听器的函数插件。在 `agent/pre-step` 上它先等待下游决定，对 `enter` 决定通过 `ctx.llm.resolveModelInfo()` 解析路由预算，经 `Session.deriveEventMessage()` 遍历表层节点，按请求顺序收集每个保留的出现位置及其持久位置，再用纯函数 `offloadedImagePrefixCount()` 对出现位置的表示字节规划删除前缀。在 `agent/request-error` 上它只处理带 `offloadImages` 的 `IMAGE_OFFLOAD_REQUIRED` 失败。两条路径都追加一个 `image/offload` 事件，指向请求序前缀中最大的持久位置；表层替换可能把该位置放在较老事件之前，推进因此可能额外省略一些出现位置，但一定覆盖该前缀。adapter 从不追加该事件：会话表层的已省略集合只有一个所有者。

本包不发布 invariant 伴生插件：`Session.append` 与 seed 已经拒绝畸形、未前进或不在表层上的水位，没有任何独立观察能与插件追加的事件产生分歧。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [持久图片 offload 水位](../../../.agents/notes/implemented/architecture/2026-09-02-image-offload-watermark.zh.md)——本插件实现的决定及其替代的方案。
- [dsh-session](../../core/session/README.zh.md)——`image/offload` 事件、它的校验与带标记的派生。
- [dsh-llm](../llm/README.zh.md)——`LlmImageRequestBudget`、`IMAGE_OFFLOAD_REQUIRED` 与共享的图片遍历。
- [llm-deepseek 适配器](../llm-deepseek/README.zh.md)——上报省略数量的 file 模式预算与内联回退。
- [llm-pi-ai 适配器](../llm-pi-ai/README.zh.md)——上报省略数量的 base64 上限。

-----

<a id="model-experience"></a>
## 模型体验

### 请求图片省略

#### 模型看到什么

位于水位及之前的每个图片出现位置，以路由的占位文本（`offloadedImageText`）到达模型，文本注明附件及其只读路径而不是图片本身；水位之后的出现位置仍是图片。该集合不会自行缩小，模型可以确信被省略的图片会一直被省略，再需要内容时通过路径读回。

#### Token 影响

被省略的出现位置只花费占位文本，不再花费视觉 token。token meter 按当前水位为当前表层定价，按每个 usage 锚点的请求派生时的水位为该锚点定价。

#### KV Cache 影响

一次推进把较早的图片替换为占位文本，该请求的 provider 缓存复用因此止于第一条被替换的消息。水位永不回退，之后的前缀保持稳定。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **被省略的图片不会自动回归**——更大的预算、更大的路由或 compaction 降低总量都不会移动水位；恢复手段是占位文本中的只读路径。
- **step 前的规划比进入的消息晚一步**——用户消息或 step 自己的工具结果新增的图片把保留集合推过预算时，会经过一次失败的尝试才到达模型。
- **临时的小预算会永久推进**——迫使内联回退的 Files 故障，或临时切到小预算路由，会省略后来的路由本可以发送的图片。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

本开发备注是非权威的工作背景：给维护者的备注和未决问题。已交付的行为与被接受的理由见上文各节、包代码和链接的 Agent Note。

- 对声明了预算的路由，step 前的规划每一步都遍历全部表层节点，没有缓存保留集合。只有在图片密集的长会话中拿到 profiling 证据后再考虑优化。

</details>
