# Agent Note: Trusted native tool policy

Status: implemented

[English](2026-10-28-trusted-native-tool-policy.md) | 中文

## Problem

`ToolRuntime.restrict()` 会先过滤继承工具，再把当前作用域自己的注册工具叠加到过滤结果之外；保留的 `run_code` transport 也不在可过滤工具层内。这些组合规则适用于委派子工具，但无法为整个可信 Agent 进程执行可选的只读工具策略。模型可见的角色指令或声明式能力列表都不是 dispatch 控制。

配对的 Agent Core Spec `AGENT_CORE_TRUSTED_NATIVE_TOOL_POLICY_V1` 定义可信启动字段，并将其绑定到精确的 `agentId` 和策略摘要。本 Note 仅定义 DSH 侧的接收、视图投影和 dispatch 行为。

## Decision

当可信 Agent Core 初始化请求携带受支持版本的 native-tool-policy 时，DSH 必须在接纳任何模型请求前校验精确的 `agentId`、策略摘要和 allowlist。无效或不受支持的策略必须拒绝，且不能回退到 unrestricted 行为。请求未包含该字段时保留现有行为。SDK JSON-RPC server 会确认版本、`agentId` 和摘要；对于启用策略的请求，TypeScript client 要求收到完全匹配的确认。

对于启用策略的 Agent，DSH 将同一份精确正向 allowlist 应用于模型可见的 native tool 视图和每次 native dispatch。最终检查必须在工具 handler 开始前执行，并覆盖部署级 global 注册、ancestor 注册、scope-local 注册、直接 `tools.execute()` 调用，以及 Code Mode transport 和嵌套调用。它拒绝缺失或不匹配的 Agent scope、未列出的工具或操作、只读策略下的 `run_code`，以及任何无法精确匹配的请求。隐藏 schema 不构成授权。

策略在进程代生命周期内绑定到 DSH ToolRuntime。每个 Agent scope 使用同一进程策略；任何 scope 都不能扩大 allowlist 或豁免自己的注册。最终授权检查实际解析后的调用，包括 scope-local 覆盖；allowlist 中不存在的 selector 一律拒绝。策略校验时，selector 名称必须已注册（保留的 `run_code` 名称始终可识别）；之后 scope-local 覆盖已注册名称仍受同一 selector 约束。契约按精确工具名和（如适用）精确操作匹配；它不声称区分两个有意暴露相同 selector 的可信注册。插件代码和注册组合仍属于协作式信任域。

selector 使用精确工具名；多操作工具可附带 `argumentEquals`，按 RFC 8785 canonical JSON 值相等匹配调用参数的指定顶层 own-property。只有当已注册工具契约声明这些 selector 键足以完整确定操作时，才允许其他参数字段；否则 selector 必须匹配完整参数对象，否则拒绝。selector 键必须是既有工具契约中可靠的操作判别字段。缺失、歧义、格式错误或不支持的操作 selector 必须失败关闭。同一工具名下重复或相互重叠的 selector 必须在策略校验时拒绝。不接受通配符名称或推断的角色标签。“只读”描述本机文件和进程能力；若可信策略显式选择精确操作，业务 Broker 操作（例如 workflow transition 或 assistance-open）仍可允许。现有 Broker gateway 授权继续生效。

ToolRuntime 策略 helper 将 allowlist 投影到 schema，并在最终 native dispatch guard 执行检查。启用策略时，dispatch 身份和参数属性在 pre-execute waterfall 中不可修改，因此 listener 不能把拒绝的操作改写成允许的操作。实现不新增通用 IAM、OS sandbox 或权限 provider 抽象。

## Alternatives considered

**单独使用 `tools.restrict()`。** 它无法命名保留的 `run_code` transport，并且有意保留 scope-local 注册，因此不能满足 dispatch 要求。

**把 prompt、tool 描述或文件系统 `read-only` 模式当作策略。** 它们只影响模型指引或一个 filesystem backend，不能阻止直接 dispatch、Code Mode、shell 工具或 scoped 注册。

**构建通用权限服务或每 Agent 进程 sandbox。** 这超出 native tool-call allowlist 范围，也与当前协作式共享主机信任模型不符。可信插件代码和直接服务调用仍在本提案范围之外。

## Consequences

- DSH 在模型工作开始前校验受支持版本、精确策略摘要、工具名注册、selector 结构以及 selector 重叠；Core 负责 resolver 身份和进程复用绑定，DSH 回传已接受的身份与摘要供 Core 校验。
- 启用策略后，系统只允许精确配置的 native 调用，并在 handler 执行前拒绝所有未列出的调用，无论其来自 global、继承还是 scope-local 注册。任务策略可显式允许所需的 workflow transition/open 操作，同时拒绝未配置的本机写入、编辑、shell 和任意代码工具。
- 除非不同的可信策略明确允许，`write`、`edit`、`bash`、`run_code`、未列出的 Broker 操作及新注册工具均被拒绝；只读策略不允许这些本机写入或任意代码入口。未知 selector 名称会导致初始化失败。
- 直接 dispatcher 调用及 Code Mode 直接/嵌套入口不能绕过最终检查。schema 不可见不能作为唯一验证。
- 缺少策略时保留 legacy 行为。Owner 的独立可信配置可显式允许指定修复工具；显示名、prompt 或模型角色不会触发该配置。
- 测试使用真实 ToolRuntime dispatch 和带副作用计数器的 fake handler；无需模型、服务、凭据或生产运行。

## Risks

本策略只约束经由 DSH `ToolRuntime` 路由的调用。它不隔离可信插件、直接服务访问、native module、任意 Node 代码或操作系统进程。已安装插件和工具组合仍属于协作式信任域。除非明确列出，`run_code` 一律拒绝；其他策略必须给出自己的精确 allowlist。

当前 Code Mode `run_code` 是位于 `ToolRestriction` 外部的保留 presentation transport；聚焦测试证明策略未列出它时，直接 dispatch 会在程序体开始前被拒绝。guard 在 scope resolution 后检查实际解析调用。工具注册仍可信；本 Note 不承诺隔离恶意插件或区分有意使用相同名称的注册。
