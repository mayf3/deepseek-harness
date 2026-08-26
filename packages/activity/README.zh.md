---
description: "activity 包组：packages/activity/ 下的非消费实时输出观察面，供选择或导航该家族的读者使用。"
kind: "package-group"
---

# activity/ — 流式输出观察家族

[English](README.md) | 中文

## 概述

这个家族让任意数量的独立观察者在不触碰模型可见路径的前提下观看长时运行生产者的实时输出：一个 activity 是一条只追加、有界的输出流加实时状态，以跨淘汰仍有效的绝对字节偏移读取。`activity` 定义注册表契约与词汇；`activity-local` 实现内存环形缓冲注册表。该观察面是可选的且对模型不可见——没有它的组合只失去实时观察。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

Service Definition 与其本地实现：

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`activity/`](activity/README.zh.md) | 定义观察注册表与词汇 | `ctx.activities` |
| [`activity-local/`](activity-local/README.zh.md) | 实现内存环形缓冲注册表 | 注册在 `ctx.activities` |

<a id="related-documentation"></a>
## 相关文档

- [`dsh-api-activity-controller`](../api/activity-controller/README.zh.md)——架在该面之上的 Web 传输与客户端模型。
- [`dsh-client-ui-activity`](../client/ui-activity/README.zh.md)——渲染它的会话头部任务列表。
- [docs/subsystems/activity.md](../../docs/subsystems/activity.zh.md)——子系统参考：偏移、留存、监听器投递。
- [activity 观察面 Agent Note](../../.agents/notes/implemented/feature/2026-08-24-activity-observation-seam.zh.md)——设计决策；后台 bash/pwsh 与 workflow 工具是已交付的生产者。

<a id="dev-note"></a>
## 开发备注

无。
