# Agent Note: Client Session、Conversation 与 UI 所有权分层

Status: implemented

[English](2026-08-20-client-session-conversation-ownership.md) | 中文

## 问题

通用 Client Runtime 同时承载 Session 与 Workspace 对象、Conversation 组装、React hooks、Slot 注册表和 Store 引擎。领域消费者因此依赖一个持续扩张的聚合包，Session 快照也容易混入事件窗口与具体视图数据。

## 决定

Session 与 Workspace 的 Client 对象分别归 `api/session-controller/client` 和 `api/workspace-controller/client`，只发布 React-free 快照。`ui-session` 与 `ui-workspace` 提供 React adapter；需要同时读取两个 Controller 的初始选择、blank Session 复用和 New Session 导航归 `ui-workspace`，不形成联合快照。Session 快照不暴露原始事件，`ui-conversation` 从内部事件源组装 Conversation，再由 `ui-chat`、`ui-trajectory` 提供目标视图。Approval 与 Question 各自持有 pending 对象和 Remote Event listener，仅把统一 pending source 登记给 `ui-session`。Store 引擎归 `client/store`，Slot 注册、scope materialization 与 hook 绑定归 `ui-renderer`；`client/runtime` 被删除。

## 备选方案

**保留 Runtime facade。** 这会继续形成依赖汇点，并允许新代码绕过领域 owner。

**让 Controller 直接提供 React hooks。** 这会让协议与状态对象依赖 React，阻止非 React 消费者复用。

**把 Conversation 数据放回 Session 快照。** 这会让每个目标视图的结构变化扩大 Session API，并迫使普通消费者理解事件组装。

## 后果

数据 owner、React adapter 和具体视图可以独立演化，Slot 仍通过标准 props 注入 hook。代价是组合包必须显式装载所需 adapter 和视图插件；缺失具体目标插件时 shell 仍可运行，但不生成该目标视图。
