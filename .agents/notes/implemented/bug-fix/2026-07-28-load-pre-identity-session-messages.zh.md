# Agent Note: 加载消息标识机制引入前持久化的会话

Status: implemented

[English](2026-07-28-load-pre-identity-session-messages.md) | 中文

## 问题

带标识的不可变消息变更将四种持久化事件载荷替换为完整消息值。现有 v0 JSONL Session 仍保留紧邻该变更之前的表示：用户事件和 steering（中途引导）事件直接携带 `content`/`source`，assistant 事件携带 `content`/`provenance`，工具结果则携带 `callId`/`content`/`isError`。这些 Session 的 header 仍与 `SESSION_FORMAT_VERSION` 匹配，但当前表示验证会拒绝它们，导致恢复流程无法构造 live `Session`。

消息表示改变时没有提升版本，导致这些日志无法仅凭 header 与当前 v0 日志区分。运行时需要一条范围受限的导入规则，既能恢复受支持的 first-party provider 所创建的数据，又不削弱对无关过时事件或格式错误事件的验证。

## 决策

冻结的 `@deepseek-ai/dsh-session-format-v0-to-v1` 迁移边会在 v0 解码之后、v1 验证之前，规范化消息标识机制引入前的四种特定消息载荷。它将载荷现有的语义字段包装进当前按角色区分的消息结构，并为其分配确定性的导入用 `MessageId`：`legacy-message:<session-id>:<event-seq>`。旧版 `tool/result` 的内容替换会继承替换目标导入后的 id，从而保持当前仅改写内容的不变量。

每项事件正文操作都会在构造当前 Session 前，通过构建期静态目录运行同一条迁移边。因此，`load`、`inspect`、无 owner 状态接管、HMR（热模块替换）前缀接管、查询、导出、fork 与后缀读取都会看到同一份规范化当前代际。看似当前结构、但字段缺失或无效的包装层不会被修复；不受支持的事件词汇、请求 header、版本和 surface 关系仍沿用现有拒绝路径。

JSONL 迁移会保持精确的无后缀 v0 产物路径、字节与 inode 不变，并在其旁边排他发布 `session.v1.jsonl[.zstd]`。确定性标识使重复恢复能够复现相同的消息 id，后续 append 只以 v1 为目标。

## 考虑过的替代方案

**拒绝这些已发布日志。** 即使每个旧字段都能明确映射到当前消息表示，这也会导致真实的第一方会话无法恢复。

**在协调器中保留同版本导入器。** 这可以避免迁移边，但会把历史 payload 留在当前 Session 代码中，而且既没有不可变源／后继命名，也没有可独立测试的发布。已发布相邻迁移系统负责规范发布。

**每次加载时随机生成 id。** 这些消息会满足类型形状，却无法在检查、恢复、重启以及新旧形状混合追加之间保持稳定标识。

## 后果

消息标识机制引入前的 JSONL Session 可以恢复，并保留原始消息内容、来源、assistant 的 provider／model 字段、工具调用关联、错误、元数据和 surface 替换。除此之外，返回事件与当前导入的消息快照无法区分，并且仍然经过深度冻结。

这是一项显式的已发布 v0 规范化，而非宽松的兼容层。若要增加另一项规范化，必须在冻结迁移边中提供另一套完整且无歧义的映射；当前数据若格式错误，系统仍会拒绝，而不会猜测如何将其变成有效数据。迁移边与 JSONL 代际测试会验证恢复的确定性，以及工具结果替换时的标识继承。

## 相关

- [将每条消息创建为带标识的不可变值](../architecture/2026-07-28-identified-immutable-message-values.zh.md)：该记录负责当前的消息标识与不可变性约定。
- [会话持久化作为抽象服务](../architecture/2026-06-14-session-persistence.zh.md)：该记录负责仅追加后端与恢复边界。
