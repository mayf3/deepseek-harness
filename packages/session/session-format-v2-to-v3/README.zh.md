---
description: "将已发布的 v2 Session 日志恢复为 v3，保留所有事件。"
kind: "package-library"
---

# @deepseek-ai/dsh-session-format-v2-to-v3

[English](README.md) | 中文

## 概述

本库将已发布的 v2 Session 记录恢复为 v3，保留事件载荷、序列引用、时间戳、顺序和继承前缀。持久化通过静态 Session 格式目录使用本库。本库不发布或修改持久化文件。

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

头部版本变为 3，其余头部字段保持不变。阶段同步转发事件和紧凑事件段，但拒绝 `sessionFormatVersion` 为 3 的源投递标记，因为升级会激活未经确认的目标代际水位。标量继承 end-seed 标记在 EOF 确定精确切点。V3 记录编码和校验复用冻结的已发布 v2 实现，不修改该实现。未知必需事件仍被拒绝；已安装事件类型和可忽略的未知事件保留其准入规则。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[阶段](src/migration.ts)跟踪继承切点和源投递归属，不改变事件值。[编解码器](src/codec.ts)改变物理头部版本并共享 v2 记录编码。[校验器](src/validation.ts)先检查 v3 版本，再执行已发布 v2 事件校验。本库不拥有可独立观察的运行时注册或状态副本，因此不发布运行时不变量伴随入口。

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

`sessionFormatV2ToV3` 保留每个模型可见事件及其载荷。

#### Token 影响

不添加或删除模型可见内容。

#### KV Cache 影响

模型消息前缀保持不变。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **不发布文件** — 持久化负责不可变后继代的发布；本包绝不覆盖已发布代。
- **仅恒等转换** — 阶段不引入结构性事件转换。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
