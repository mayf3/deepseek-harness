# @deepseek-ai/dsh-web-fetch-approval-policy

[English](README.md) | 中文

一个为 `web_fetch` 作单次权限决策的 `tools/pre-execute` 策略。它组合调用会话的 sandbox mode 与审批策略，并使用 [`dsh-web-fetch-http`](../web-fetch-http/README.zh.md) 在询问用户前执行不产生网络活动的校验。

## 决策

| Sandbox mode | 审批策略 | `web_fetch` 决策 |
|---|---|---|
| `danger-full-access` | 任意 | 不询问并委托后续策略。 |
| `read-only` 或 `workspace-write` | `ask` | 不产生网络活动地校验 URL，然后请求单次审批。 |
| `read-only` 或 `workspace-write` | `never` | 不进行 DNS 解析或提示，直接拒绝。 |

受限模式下的无 agent 调用会被拒绝，因为它没有可用于策略查询和审批审计的 session；无 agent 的 `danger-full-access` 调用会继续委托。格式错误的参数和未知工具交给注册表自身校验。此插件从不自行授予调用：它先计算下游策略，不受限调用保留下游结果，受限调用也只会在下游允许后询问。

审批请求携带精确的工具 `callId`，其 reason 包含完整的标准化 URL、sandbox mode 与单次调用范围。只有现有的 `allowed-once` 结果允许执行；拒绝、取消或无可用回答方都会 fail closed。按 session／域名持久化和永久授权不属于此包。

## SSRF 分离

权限校验会在显示提示前检查 URL 语法、固定长度上限、内嵌凭据和 IP 字面量。它不执行 DNS 查询，因此拒绝或取消提示不会通过解析器泄露由模型控制的 hostname 数据。

`allowed-once` 之后，HTTP 提供方才会在每次实际连接前解析 hostname、拒绝任何非公开解析结果、固定已验证地址，并对每个被跟随的同源重定向重复校验。用户不能授权私有目的地址；跨源重定向需要新的 `web_fetch` 调用和权限决策。

## 模型体验

通过 `dsh-tools` 与 `dsh-user-approval` 间接影响；它们让受限调用等待单次审批，并通过既有工具错误路径返回拒绝结果。

#### KV Cache 影响

无。该策略改变执行，不改变面向模型的 schema 或提示词文本。

## 已知限制与暂缓事项

- 不存在按 session 或域名限定的持久授权。
- `plan` 是协作状态，不是 sandbox mode。希望 plan 工作采用受限 Web 访问的产品，应将其与 `read-only` 或 `workspace-write` 以及审批策略 `ask` 组合。
