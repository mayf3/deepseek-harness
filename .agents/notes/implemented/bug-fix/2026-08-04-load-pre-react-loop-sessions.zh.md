# Agent Note: 加载 react-loop 重构前格式的会话

Status: implemented

[English](2026-08-04-load-pre-react-loop-sessions.md) | 中文

## 问题

react-loop 简化在保持 `SESSION_FORMAT_VERSION` 为 0 的同时更改了持久事件。该变更基线所存储的会话包含 steering（中途引导）事件 `steering/message`，以及 `turn/start.trigger` 字段；其终止原因还使用粗粒度 `aborted`、独立的 `disposed` 和两种旧版错误载荷。当前表层和轮次不变量无法直接回放这些记录。

新的持久 inbox 不属于此兼容性问题。该基线会发出进程本地 inbox 通知，但不会产生 `agent/inbox/*` 会话事件，因此将旧历史回放为待处理工作会让已经领取或丢弃的提示词再次执行。

## 决策

冻结的 `@deepseek-ai/dsh-session-format-v0-to-v1` 迁移边会在 v0 解码后识别 react-loop 重构前的确切结构，并将其投影为 v1。它移除已废弃的 `turn/start.trigger`，把 `steering/message` 转换为同一条带标识的 `user/message`，将旧版失败事实映射为当前结构化错误，把 `disposed` 折叠为带 `disposed` 原因的已中止轮次，并用仅供持久化导入使用的 `{ kind: 'legacy' }` 原因表示粗粒度中止记录，因为无法获得其调用方。

每个持久化事件正文入口都会先通过构建期静态目录迁移完整且分离的产物。因此，`load`、`inspect`、接管、HMR（热模块替换）前缀比较和 `readFrom` 会收到同一份经过校验的 v1 视图；系统只会在不可变后继发布和当前格式恢复后读取后缀。

该迁移边不会合成 inbox splice。恢复后的 react-loop 重构前 agent（智能体）从空的待处理列表开始，这与基线运行时无法持久化待处理 inbox 工作的行为一致。迁移会保持精确的无后缀 v0 generation 不变，并在后续事件 append 前发布一个 `session.v1.jsonl[.zstd]` 后继。

## 考虑过的替代方案

**将已发布记录视为不受支持。** 这会使受支持的第一方 writer 所产生的 Session 无法恢复，尽管已移除的 steering 内容和终止事实都有完整映射。

**将旧 inbox 通知回放为持久 splice。** 这些通知不是会话事件，也无法提供可信的待处理状态快照。如果无法获知每一次领取和丢弃，就推断插入操作，会让已消费的工作再次执行。

**将粗粒度中止记录归因于现有调用方。** 将其映射到 `user`、`parent` 或 `hook` 会凭空指定旧记录未注明的调用方。专用的 `legacy` 原因既能保留停止分类，也不会产生虚假的审计事实。

**在协调器中保留通用同版本导入器。** 这会让当前 Session 代码不断积累历史结构，而且没有不可变物理 generation 命名或可独立测试的相邻迁移边。已发布迁移生命周期负责该转换。

## 后果

以重构基线格式写入的会话可以通过当前 AgentLoop 恢复，并完整保留 steering 内容、轮次边界、错误事实和停止分类。冻结迁移边与 JSONL 代际约定覆盖 `load`／`inspect`／`readFrom`；组装后的 JSONL agent 恢复用例会验证历史 transcript（文本记录）可见，同时两个新 inbox 列表都从空状态开始。

此例外支持基线格式，不支持重构开发期间产生的中间格式。具体而言，它没有为更早的实验性 `agent/inbox/spliced` 载荷定义迁移。通过确切形状识别，当前格式外观相似但结构错误的记录仍会走拒绝路径，不会被猜测性地转换为有效记录。

## 相关资料

- [加载消息标识机制引入前持久化的会话](2026-07-28-load-pre-identity-session-messages.zh.md)：负责同一迁移边中另一项已发布 v0 规范化的确定性标识。
- [以抽象服务实现会话持久化](../architecture/2026-06-14-session-persistence.zh.md)：负责仅追加后端存储和恢复。
