# Agent Note: 为 Inbox 命令恢复冷会话

Status: implemented

[English](2026-08-17-durable-web-queue-recovery.md) | 中文

## 问题

Inbox 状态保存在会话日志中，但 `session.updateQueue` 之前只查找 live Agent。Host 重启后，普通持久 Session 会保持冷状态，直到某项操作需要其 Agent，因此编辑或移除已恢复的待处理项会错误返回 `queue-item-not-found`。

## 决策

`session.updateQueue` 在读取或修改 Inbox 前，通过共享 Agent 解析器解析普通冷 Session。持久 Session 确实不存在时仍映射为 `queue-item-not-found`；其他恢复失败保留原有错误，subagent ownership 也保持与其他 Agent 操作相同的限制。

解析出的 Agent 从已注册的持久投影构建 Inbox。因此，该命令会读取恢复出的待处理列表，并通过既有的规范化 `agent/inbox/spliced` 事件记录编辑或移除。系统不引入新的会话事件或磁盘格式。

## 验证

冷操作测试提供一份带待处理 Inbox splice 的分离持久 Session，调用 `session.updateQueue`，并证明 Session 会被恢复、待处理项会被移除且持久删除 splice 会被追加。

## 考虑过的替代方案

**把所有缺少 live Agent 的情况都当作队列项不存在。** 不予采纳，因为持久层可能仍拥有该普通 Session 及其持久 Inbox 投影。

**在 `session.updateQueue` 内折叠会话日志。** 不予采纳，因为 Inbox 投影已经拥有重建逻辑，而共享 Agent 解析器拥有冷生命周期初始化和 preset 组合。

## 后果

对已恢复 Inbox 项的操作使用与 live 项相同的 preset 组合、所有权检查和持久变更路径。读取持久状态本身不要求提前恢复 Agent；只有显式命令会恢复普通 Agent。
