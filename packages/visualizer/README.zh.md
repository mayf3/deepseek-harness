---
description: "Visualizer 包组：用于内联视觉组件的休眠 Host 权威与 preset-scoped 模型工具。"
kind: "package-group"
---

# visualizer/：内联视觉组件

[English](README.md) | 中文

## 概述

Visualizer 当前提供一个可独立装载的 Host／模型能力，用于临时内联视觉内容。根 Cordis service 拥有 Host 限额与已授权 widget follow-up，第二个 entrypoint 则从 Agent preset scope 贡献提示词和工具。follow-up 权威绑定到已保留的不可变 Session result，而非展示 iframe 的生命周期。默认 application composition 不挂载该权威，因此始终挂载的 model wrapper 在权威出现前不贡献任何模型面。单独提供的兼容 Client 可以消费 follow-up Remote，并应用自身的渲染限额；本包组尚不提供或激活展示能力。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

本包组目前只包含一个 Host 包，其中权威与模型入口彼此分离。

| 包 | 职责 |
|---|---|
| [`tool-visualizer/`](tool-visualizer/README.zh.md) | 提供休眠 Host 权威、生成式 follow-up Remote、preset-scoped 提示词与 Visualizer 工具 |

<a id="related-documentation"></a>
## 相关文档

- [工具子系统](../../docs/subsystems/tools.zh.md)：模型工具注册、执行与已记录结果。
- [系统提示词子系统](../../docs/subsystems/system-prompt.zh.md)：有序提示词 section 与 context contribution。
- [实现决策](../../.agents/notes/implemented/feature/2026-08-29-inline-visualizer-cordis-extension.zh.md)：休眠、权威与模型 scope 边界。

<a id="dev-note"></a>
## 开发备注

Host 权威留在根 service，模型策略留在同一包的 preset-scoped entrypoint。兼容的展示 Client 可以消费生成式 follow-up Remote，而无需向 session/core type 添加展示契约；默认 composition 不挂载任何此类 Client。
