---
description: "将已发布的 v2 Session 日志恢复为 v3，采用当前 PTC 事件名称并保留历史标识。"
kind: "package-library"
---

# @deepseek-ai/dsh-session-format-v2-to-v3

[English](README.md) | 中文

## 概述

本库通过转换持久化 PTC 事件名称和插件来源标签，将已发布的 v2 Session 记录恢复为 v3。它保留每个历史标识、事件顺序、序列引用、时间戳和继承切点。持久化通过静态 Session 格式目录使用本库。本库不发布或修改持久化文件。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [深入探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 使用场景

恢复时请使用[目录](../session-format-catalog/README.zh.md)。直接导入用于目录组装和测试；本库不挂载到 Cordis 组合中。

### 入口

```text
const targetHeader = sessionFormatV2ToV3.migrateHeader(sourceHeader)
```

头部版本变为 3，其余头部字段保持不变。阶段同步将 `tool/code-dispatch-start` 和 `tool/code-dispatch` 映射为 `tool/ptc-dispatch-start` 和 `tool/ptc-dispatch`。它仅在 `user/message.data.source`、`agent/inbox/spliced.data.inserted[].source` 和 `session/title-llm-request.data.messages[].source` 的 plugin 类型来源中，将精确匹配的 `tools-code-mode` 插件标签映射为 `tools-ptc`。其他所有值保持不变，包括含 `:code:` 的标识、消息内容、工具参数和不透明载荷。

V3 校验接受当前 PTC 标签，不接受必需的旧别名。标记为 `ignorable` 的未知事件保留其准入规则，但源 v2 中的 `tool/ptc-dispatch` 和 `tool/ptc-dispatch-start` 事件即使可忽略也会被拒绝：这些名称在 v3 中保留，迁移不能将不透明扩展重新解释为 PTC 生命周期事件。物理记录编码仍为已发布的 v2 编码；仅头部版本和上述逻辑字段发生变化。

阶段拒绝 `sessionFormatVersion` 为 3 的源投递标记，因为升级会激活未经确认的目标代际水位。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[阶段](src/migration.ts)在跟踪继承切点和源投递归属的同时，执行限定范围的 PTC 转换。标量继承 end-seed 标记在 EOF 确定精确切点。[编解码器](src/codec.ts)共享冻结的 v2 物理记录编码。[校验器](src/validation.ts)检查 v3 事件准入和关联关系，不修改冻结的前代模块。本库不拥有可独立观察的运行时注册或状态副本，因此不发布运行时不变量伴随入口。

</details>

-----

<a id="further-exploration"></a>
## 深入探索

- [已发布 v1 到 v2](../session-format-v1-to-v2/README.zh.md) — 冻结的源编解码器和事件校验。
- [Session 格式协议](../session-format/README.zh.md) — 相邻流式阶段。

-----

<a id="model-experience"></a>
## 模型体验

### 历史日志恢复

#### 模型看到什么

`sessionFormatV2ToV3` 保留消息内容和工具结果。PTC 插件来源使用 `tools-ptc`；仅日志的分发事件不会添加模型消息。

#### Token 影响

不添加或删除消息内容。

#### KV Cache 影响

阶段不改变消息内容或模型配置。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **不发布文件** — 持久化负责不可变后继代的发布；本包绝不覆盖已发布代。
- **仅限定范围的转换** — 只转换指定的事件标签和插件来源位置；不改写任意字符串、未知载荷和历史标识。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
