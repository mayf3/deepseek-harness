# Agent Note: 将一元浏览器操作放到所属 Remote 服务

Status: implemented

[English](2026-08-10-unary-apiproxy-remote-migration.md) | 中文

## 问题

Host API Proxy 曾在业务 Service、API Proxy interface、Zod schema、路由表、Client stub 与 Client 调用方之间重复定义简单一元操作。[Typert Remote 调用](2026-08-02-typert-remote-method-calls.zh.md)已经允许业务包持有这类调用，但如果迁移 endpoint 时没有一并保留生命周期与投影策略，就会改变可观察行为。

与 Agent 绑定的调用需要格外谨慎。共享 lookup 策略会复用 live Agent、用记录的 preset 恢复普通冷 Session、对并发恢复去重，并拒绝由 subagent 持有的 identity。skill 列表则必须检查 Session 而不激活 Agent。Settings 与 preset 操作不会把 Host 持有的文档路径放进浏览器请求；Session 文件链接保留由调用方解析路径的行为。

## 决策

简单一元操作归属其自然的业务 Remote owner。业务包持有 Remote 签名与 Host 适配；`@deepseek-ai/dsh-api-remotes/client` 选择其生成贡献；Client 包持有呈现联接。API Proxy 只保留 `host.describe` 与流式 `GET`/`HEAD /api/session.export`。

| 旧 RPC | Remote 目标 | Owner 与保留行为 |
|---|---|---|
| `session.rename` | `sessionTitle/rename` | `SessionTitleService` 通过共享 lookup 策略解析 Session，并返回标题事件序号。 |
| `command.list`、`command.execute` | `commands/list`、`commands/execute` | `CommandRuntime` 保留 Agent lookup、未匹配命令与调用方取消。 |
| `llm.providers` | `llm/listProviders`、`llm/listConfigurableProviders` | `LlmRuntime` 持有 provider 事实；Client 联接 live 与 configurable 行。 |
| `llm.discoverModels` | `llm/discoverModels` | `LlmRuntime` 保留 provider 发现、取消与净化后的失败。 |
| `llm.models` | `session/modelCatalog` | `SessionController` 持有 Host generation 的目录、默认选择与隔离后的 provider 失败。 |
| `credentials.describe`、`credentials.set`、`credentials.unset` | `credentials/describe`、`credentials/set`、`credentials/unset` | `CredentialsController` 保留引用校验、字段投影、provider 诊断与拒绝映射。 |
| `settings.describe`、`settings.update`、`settings.replace`、`settings.mutate` | 对应的 `settings/*` 方法 | `SettingsController` 保留脱敏、mutation 语义、revision 校验与 provider 失败。 |
| `settings.openDocument` | `settings/openSettingsDocument` | `SettingsController` 准备 provider 持有的文档，并按文本编辑器意图打开。 |
| `agentPreset.read`、`agentPreset.copy`、`agentPreset.remove` | 对应的 `agentPresets/*` 方法 | `AgentPresetService` 持有文档读取、复制与删除。 |
| `agentPreset.openDocument` | `settings/openAgentPresetDirectory` | `SettingsController` 解析 preset 目录，并在原生打开不可用时返回其路径。 |
| `subagent.interrupt` | `subagents/interruptByParent` | subagent 服务保留 parent 权限，且不激活任何一方的 Agent。 |
| `workspace.list`、`workspace.insertSessionBefore`、`workspace.archiveSession` | 对应的 `workspace/*` 方法 | Workspace registry 持有脱离可变对象的 snapshot 与串行 mutation。 |
| `skill.list` | `skills/list` | `SessionSkillCatalog` 观察 Session 及其记录的 preset，仅在 live Agent 已存在时使用它，列表查询绝不激活 Agent。 |
| `fileReferences/list` | `fileReferences/list` | `SessionFileReferences` 向 provider 提供 Session Controller 的既有 Agent lookup；冷 lookup 行为保持不变。 |
| `host.openPath` | `session/openWorkspacePath` | Session-aware Client 先基于已知 workspace 解析相对路径，再由 `SessionController` 交给原生打开器。 |

共享 Agent 与 Session resolver 仍是接收这些对象的 endpoint 的权威。它提供与旧 API Proxy 调用相同的 live 复用、冷恢复、并发去重、preset setup、持久化失败与 subagent ownership fence。`TypertLookupFailure` 保留 resolver 持有的 RPC error，而不把它们归并为 `internal`。

原生路径实现在 `@deepseek-ai/dsh-native-command` 中。Settings controller 选择 Host 持有的目标，Session-aware Client 则在调用 `SessionController` 前解析 workspace 路径；该工具仅负责平台探测、WSL 转换、浏览器偏好、文本编辑器意图与无 shell 命令执行。

## 浏览器认证

Connection 在选择 Typert interceptor 或 API Proxy fallback 前认证完整的 `/api` 请求。因此 Remote 持有的 endpoint 与保留的 API Proxy endpoint 要求相同的浏览器会话和 Host/Origin 校验。

## 验证

聚焦的 Host 与 Client 测试覆盖 Remote 调用、lookup 与不激活策略、原生打开、错误投影和 legacy 路由移除。仓库构建会先生成并消费所选 Remote contribution，再构建 Web 应用。

## 考虑过的替代方案

**将简单调用留在 API Proxy。** 否决，因为业务 owner 已存在后，这仍会保留重复的 interface、schema、路由行、stub 与结果投影。

**迁移每一个一元操作。** 否决，因为 `host.describe` 组合部署事实与 Connection readiness，而 Session export 是流式下载，不是一元业务方法。

**把原生打开操作放入某个 controller。** 否决，因为 Session、Settings 与保留的 Host 描述都会消费同一平台操作。Host 工具可以避免 controller 间导入与重复的平台逻辑。

## 后果

业务 owner 与 Client consumer 各自定义一元操作的一侧，而 Connection 继续持有认证、传输与响应 envelope。删除 legacy Client timeout 是已接受的可观察传输变化；业务结果、取消、生命周期策略、过滤与原生路径权限仍由既有领域持有。

每当 Remote 签名或所选包发生变化，都必须更新生成的 Remote 产物和显式 API Remotes assembly。
