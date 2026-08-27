# Agent Note：相邻 Agent 共享一个 Steer 消息操作

状态：已实现

[English](2026-08-27-adjacent-agent-steer-messaging.md) | 中文

## 问题

可继续 Agent 曾使用按方向划分的公开操作与消息来源。parent 使用 `followup(parent, childId, content, { source, signal })`，child 使用 `reportFrom(child, content, { delivery, signal })`。前者创建后续 FIFO 轮次并接受调用方提供的来源信息；后者通过部署配置选择静默注入或 next-step steering，并在内部推导接收方。

这些差异描述的是最初消费服务的工具，而不是两种生命周期能力。两个方向都跨一条 parent/child 边投递模型编写的内容，都要求继续执行管理器授权确切在线 Agent，也都依赖相同的驻留与冷恢复所有权。按方向划分来源还会让等价消息以不同方式重建。

[Issue #3220](https://github.com/deepseek-harness/deepseek-harness/issues/3220) 要求先统一这层基础，再统一面向模型的工具。

## 决策

`SubagentRuntime.sendMessage(sender, targetId, content, { signal })` 是唯一公开的模型编写消息操作。继续执行管理器只接受确切在线 sender，以及位于一条相邻边上的目标：

- parent 到直接可继续 child，由 child 持久化的 `SessionHeader.parentSession` 授权；
- 驻留的可继续 child 到其确切在线直接 parent，由 child 的 Activation 授权。

sibling、self-target、相隔多于一条边的 ancestor、陈旧 Agent 对象、未知目标与一次性 child 都不是备用路由。该操作不接受调用方提供的 source、投递模式、离线 parent mailbox 或提供方分发。

每条被接受的消息都使用 `Agent.steer()`。运行中的目标在最近的 step 边界接收消息；空闲目标启动一个轮次。不存在 Activation 的直接 child 会先经既有继续执行生命周期完成冷恢复，再接受相同的 Steer 投递。管理器保留唤醒发送记账，避免受继续执行管理的目标在同步 inbox 插入与 driver 准入之间结算。

两个方向都使用同一个持久化来源：

```ts
type SessionId = string

interface AgentMessageSource {
  readonly kind: 'agent-message'
  readonly form: 'relay'
  readonly senderSessionId: SessionId
}
```

服务从已授权 Agent 推导 `senderSessionId`，并把模型可见内容设为 `Agent <sender-id> sent a message:` 前缀。来源信息因此无法偏离权限。由 runtime 生成的 `subagent-settled` 通知保持独立，因为其中的文字是管理器的记账，而不是 Agent 选择的内容。

浏览器中的人类提示不是由模型编写的 Agent 消息。既有远程提示路径保留私有 Queue 投递，使每条人类提示继续形成独立轮次。中断行为与结算投递不变。

child 作用域的 `report` 工具暂时推导 parent id，并适配到 `sendMessage()`。其 `reportDelivery` 配置被移除：被接受的报告现在与 parent 到 child 的内容使用相同的固定 Steer 调度与 `agent-message` 来源。后续变更可以统一面向模型的工具，而无需改变该服务决策。

## 考虑过的替代方案

**保留 `followup` 并添加 child 到 parent 路由。** 该名称承诺后续轮次，并继承 `Agent.followup()` 语义。它会掩盖已选择的最近 step 行为，也会为方向中立的能力保留以 parent 为中心的操作名称。

**在同一实现上保留独立的 `followup` 与 `reportFrom` 方法。** 两个公开方法仍允许不同的 options、来源信息与错误行为重新出现。工具专属适配器应归 Consumer 包所有，而不是归 Service Definition 所有。

**允许调用方提供 `MessageSource`。** sender Agent 已是权限凭据。接受独立来源信息会允许调用方记录一个不同于管理器已授权 Agent 的作者。

**保留静默投递作为部署策略。** 静默的模型编写消息可能已被接受，但空闲目标永远不会读取。固定 Steer 为两个方向提供同一种投递含义，并保留运行中目标 step 边界的批处理。

**对空闲目标使用 `Agent.followup()`，对运行中目标使用 `Agent.steer()`。** `Agent.steer()` 已定义这两种情况。根据发送前读取的状态选择方法会增加竞态与两个 inbox 目标，却不会改变预期的空闲行为。

## 后果

- 服务 Consumer 只有一个方向中立的模型消息操作与一种来源词汇。
- 继续执行管理器仍是相邻关系授权、驻留、冷恢复、唤醒准入与拆卸竞态的唯一所有者。
- 被接受的消息可能延长运行中目标的当前轮次。多条共同等待的消息共享 next-step FIFO 顺序。
- 调用方取消只在 inbox 接受前掌管工作；它不会撤回已接受消息，也不会 dispose 目标。
- 人类提示、结算通知、QueueDock 与启用可继续 fork 仍是独立决策。

本决策取代[按意图命名的 subagent 继续执行操作](../simplification/2026-07-27-intent-named-subagent-continuation-operations.zh.md)中的 `followup` 命名选择、[可继续 subagent report 工具](../feature/2026-07-30-continuable-subagent-report-tool.zh.md)中的公开 `reportFrom` 与可配置投递部分，以及[Subagent 报告先于其结算通知](../bug-fix/2026-08-17-subagent-report-settlement-ordering.zh.md)中的 report 专属投递选择。它们关于提供方、设置贡献、提示词指导、持久性与结算顺序的理由，在未被本记录取代之处仍然适用。
