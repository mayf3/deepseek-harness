# Agent Note: 产品 subagent 公开有界结构化失败事实

Status: implemented

[English](2026-08-18-product-subagent-failure-facts.md) | 中文

## Problem

[Claude Code 与 Codex 产品提供方](2026-08-04-claude-code-and-codex-subagent-backends.md)会收到结构化产品失败，但已发布运行以往会把其中大多数压成共享的 `error` 终止原因。产品日志保留了细节，前台父 agent 与[一次性后台 Job](2026-08-12-product-subagent-one-shot-background-tasks.md)却无法据此区分产品限制、执行失败或进程提前退出。

若把 SDK 错误文本、app-server payload 或 stderr 复制进结果，就会暴露任务文本、路径、环境值、凭证或产品内部信息。若增加共享错误字段，又会让提供方无关的 [subagent seam](2026-06-21-subagent-capability-seam.md)拥有彼此独立变化的产品版本词汇。

## Decision

每个产品提供方分别拥有从锁定版本官方错误联合、当前操作和受管进程结果到一行固定安全诊断的映射。`SubagentResult` 保持不变：消费方仍接收现有的有界 `diagnostic` 字符串，而且不解析其中由产品私有的字段。

### 安全诊断

结构化行采用以下固定顺序：

```text
Product subagent failure (product: <product>; stage: <stage>; category: <category>; exit code: <code>; signal: <signal>)
```

提供方会省略不可用的退出字段。退出码与信号是相互独立的事实，只要已观测到就分别保留。来自[非交互权限决策](2026-08-15-product-subagent-noninteractive-permissions.md)且参与失败的权限决定会跟在结构化行之后；最新的安全权限事实仍只属于当前操作。共享结果边界会把完整文本限制在 4096 个 UTF-8 字节以内。

成功结果与本地取消都不公开失败事实。原始产品错误、stderr、工具输入、路径、环境值、凭证和协议 payload 绝不会进入诊断。启动与清理拒绝会在 Error 消息中使用同一安全行，而原始失败只保留在内部 cause 链与 Host 日志中。

### Claude Code 事实

Agent SDK 0.3.220 定义四种错误子类型：`error_during_execution`、`error_max_turns`、`error_max_budget_usd` 和 `error_max_structured_output_retries`。Claude Code 提供方会把每种准确子类型保留为类别，同时维持共享终止原因 `error`。标记为错误或内容空白的成功消息使用 `invalid-success`，缺失结果使用 `missing-result`，SDK 给出终态结果前发生的进程退出使用 `process-exit`，无法识别的值或异常使用 `unknown`，且不会复制原值。

| 阶段 | 归属操作 | 可观察失败 |
| --- | --- | --- |
| `query-start` | 原生可执行文件解析、SDK query 构造与未发布回滚 | `start()` 以固定安全事实和回滚前已观测到的进程结果拒绝 |
| `query-run` | 已发布 SDK 消息迭代与严格终态结果校验 | 运行以 `error` 兑现，并携带准确已知子类型或固定结果类别 |
| `process` | SDK 提供终态结果之前受管 CLI 已退出 | 运行以 `error` 兑现，并携带 `process-exit` 以及可用的退出码和信号 |
| `teardown` | Query 关闭与受管进程树释放 | `dispose()` 独立拒绝并携带固定安全事实，同时清理仍会完成最终退出等待 |

Codex 提供方保留既有结果映射：`contextWindowExceeded` 是 `max-tokens`，其他轮次失败仍是 `error`，权限相关路径可以携带既有安全诊断。本决策的当前实现不会把其他 Codex error-info 成员表示为共享类别。

### 所有权与生命周期

| 事实或资源 | Owner | 消费方行为 |
| --- | --- | --- |
| 产品错误类别 | 锁定版本的官方 SDK 或 app-server | 提供方只映射已声明的结构化联合，并对联合外值使用 `unknown` |
| 当前失败阶段 | 产品提供方操作 | 只在失败点派生；绝不持久化，也不作为恢复状态 |
| 退出码与信号 | `dsh-subprocess` 进程句柄 | 提供方展示已观测值，不推测缺失值 |
| 诊断字节与送达 | `dsh-subagent`、前台工具与 Job 运行时 | 两种调度模式都把同一份有界文本与 assistant 输出分开呈现 |
| 原始产品失败 | 产品运行时与 Host 日志 | 只保留在内部，绝不成为模型可见的结果文本 |

## Verification

Claude Code 包测试固定四种 SDK 子类型、无效成功、缺失结果、未知值与异常、四个阶段、相互独立的退出码与信号字段、权限事实顺序、脱敏、成功结果与取消时省略诊断、并发运行隔离和清理完成。真实 SDK/CLI fixture 会产生真实的 `error_max_turns` 结果与真实的进程提前退出，并证明整棵进程树完全停稳。无密钥 ACP snapshot 会在前台错误输出、后台完成通知和 `job_output` 中记录同一份失败诊断。

## Alternatives considered

**返回原始 SDK 错误、app-server payload 或 stderr。** 这些值可能包含命令、路径、工作区内容、环境值、凭证或上游文本。固定白名单映射可以保留可操作事实，同时不扩大模型可见的信任边界。

**增加共享产品错误 enum 或结构化结果字段。** Claude Code 与 Codex 各自独立版本化错误联合。共享 enum 会复制这些权威，并迫使无关提供方和消费方跟随产品版本。

**解析通用 stderr 与异常消息。** 自由文本既不稳定也不安全。只有锁定版本产品提供的结构化字段和受管进程结果可以成为诊断输入。

**持久化阶段或增加恢复控制器。** 阶段只在报告失败时从当前调用点派生。持久化、重试、resume 与修复需要独立的所有权和用户约定。

**把产品限制映射为新的共享终止原因。** Claude Code 的轮次和预算限制并不表示 token 窗口耗尽，错误类别也不能证明拒绝语义。既有终止原因保持不变。

## Consequences

父 agent 可以区分重要的 Claude Code 产品限制、无效终态结果、未知 query 失败和进程提前退出，而不会收到原始产品文本。前台与后台调度会保留同一事实，因为二者都消费同一个 `SubagentResult`。

诊断只是展示文本，不是新的公开协议。调用方可以呈现它，但不得根据其标点或产品私有类别名称进行分支。锁定产品版本升级并改变官方错误联合时，必须同步更新提供方映射与证据。

本决策不增加产品会话持久化、重试策略、恢复状态、stderr 分类器、身份验证或配置分类体系、进度流或人工交互路径。
