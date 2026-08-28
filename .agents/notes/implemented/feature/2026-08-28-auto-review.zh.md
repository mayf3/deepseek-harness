# Agent Note: shipped Web 应用中的逐调用 Auto review

Status: implemented

[English](2026-08-28-auto-review.md) | 中文

## 问题

权限预设层可以命名沙箱与审批策略的组合，但两种机制都无法判断某次具体工具调用是否仍在用户的语义授权范围内。Full access 不会打断用户请求审批，却会让每个获准调用都以宿主环境权限执行。因此，实用的自动模式需要在调用时作出决定，同时不能把 LLM（大语言模型）判断伪装成文件系统隔离，不能把 reviewer 分析泄漏给主 agent，也不能让持久化模式在 integration 缺失时退化为未经审查的 Full access。

## 决策

shipped Web 应用把 `Auto review` 作为第四个完整的当前会话权限模式。它的持久身份是 `permission/preset:auto`，执行旋钮精确等于 `danger-full-access` 加审批策略 `never`。[`@deepseek-ai/dsh-auto-review`](../../../../packages/interaction/auto-review/README.zh.md)拥有额外授权行为；[`dsh-permission-presets`](../../../../packages/interaction/permission-presets/README.zh.md)只拥有受 effect 作用域约束的 contribution 目录、规范预设写入路径，以及在选择或恢复时以拒绝方式关闭的准入。

Auto 是实验功能，因为 LLM 决定具有概率性。获准调用会立刻以完整宿主访问权限开始，之后没有人工确认。因此，reviewer 可能放行本应拒绝的动作或拒绝有效动作，而且每次审查都会增加提供方延迟与 token 用量。

## 支持的产品表面

composer 当前会话选择器与 `/permission` 斜杠选择器会显示带 `EXP` badge 的 `Auto review`。通过任一可见选择器选中 Auto 时，都需要针对该次选择确认一次；显式提交的 `/permission auto` 命令已经表达同意，不会增加另一项协议步骤。General Settings 永远不会把 Auto 提供为未来会话默认值。

shipped Web 组合是唯一受支持的宿主。Headless 保留既有 Workspace Write 默认值与审批行为。DSH in-process child 会在第一次 await 前快照并追加 Auto 父级的预设身份，因此同一 integration 会审查其调用。ACP、DSH SDK、Codex 与 Claude Code child 在父级委派工具调用通过审查后，仍使用各自的权限系统。

## 审查请求与决定

Auto 插件以前置方式注册一个 `tools/pre-execute` 监听器，并为每次原生调用与每次实际开始的 PTC inner call 最多尝试一次直接 reviewer 请求。必需的日志事实无法形成完整请求时，它会在联系提供方前拒绝调用。它会委派外层 `run_code` 传输，因为程序文本不能代替其 inner call 的实际效果。重复调用会独立接受审查；不存在缓存、grant、批量决定或重试层。

reviewer 使用最新记录在 `request/header` 中的提供方与模型。其不可变请求包含五个分区：固定 `REVIEW_POLICY`；只含 Session `cwd` 的 `ENVIRONMENT`；当前 `PROJECT_INSTRUCTIONS`；`FILTERED_HISTORY`；以及精确的 `PENDING_ACTION`。原生动作使用匹配的已记录 `tool/call` 与最新已记录工具 schema。PTC 动作使用匹配的 `tool/code-dispatch-start`；该事件会在策略前快照 inner tool 的名称、描述、参数 schema 与规范化参数。事实缺失、含糊或不一致时会拒绝调用，而不会查询 live 注册表。

direct-user 消息、压缩检查点与当前 `agent-instructions` 可以授权。其他 user-role 内容以及历史原生或 PTC 调用只能作为证据。请求排除 assistant 文本、推理、工具结果、Git 状态、环境变量、平台 metadata 与 shell 方言。如果过滤后的请求仍超出模型上下文、提供方失败，或输出不是恰好一个受支持的 `allow` 或 `deny` JSON 对象，调用会被拒绝。

## 结果与生命周期

Auto 拒绝使用与人工拒绝相同的模型可见错误文本。Tool 结果另行携带 `AutoReviewDeniedError`、`AUTO_REVIEW_DENIED` 与 reviewer 提供的可选 raw string reason。原生 `tool/result` 与 PTC `tool/code-dispatch` 事件为回放和两套 SDK 保留相同的结构化 `error` 字段。Web 工具行会跨 generic、专门视图与 shell 展示识别该身份；折叠状态显示 Auto review，展开后的 OUT 行会 trim 原因、折叠换行，并在没有可显示原因时使用本地化 fallback 文案。主 agent 与 PTC 程序绝不会收到 reviewer 原因或 Auto 身份。

调用方取消沿用普通 Tool 取消结果。被拒绝的 PTC inner call 保留既有 `ToolCallError` 与程序 `catch` 行为，因此被处理的拒绝不会转成外层 `run_code` 失败。允许决定不产生事件、原因或持久 grant。

发布与资源释放均以拒绝方式关闭。存储的 Auto 会话只有在 contribution 为 live 状态并准入该精确 Session 时才能发布；服务不会把它改写为 Full access。资源释放期间，integration 会先关闭新的 Auto 选择与审查准入，通过普通预设写入器把所有 live Auto Session 切换到 Read Only，中止并等待在途审查，最后才移除监听器与 contribution。若有 Session 无法迁移，integration 仍会中止并排空审查，但会保留已关闭的监听器与 contribution，使新的 Auto 选择失败，并让剩余 Auto 调用被拒绝，而不是留下未经审查的执行窗口。

## 验证

单元与集成测试固定五个请求分区、授权来源标签、原生与 PTC 动作重建、一次审查基数、审查先于工具主体、严格输出解析、技术故障拒绝、调用方取消、恢复失败与资源释放顺序。Tool 与客户端套件固定结构化错误传播，以及各内置卡片家族一致的 Auto 拒绝展示。TypeScript 与 Python SDK fixture 固定原生和 PTC 投影事件中的 `name`、`code` 与 `reason`。真实 DeepSeek e2e runner 以恰好十六次独立 reviewer 调用执行八组配对场景，覆盖读写范围、删除、force push、生产变更、携带 credential 的外部消息、安全控制、检查点授权、项目指令授权与历史调用伪装；工具主体均为无副作用 sentinel。

## 考虑过的替代方案

**把 `auto` 加入 `ApprovalPolicy`。** 未采用，因为 Auto 是由 Full access 执行加独立语义 reviewer 组成的完整产品模式，不是人工审批服务的第三种响应策略。扩展该 enum 会制造不受支持的沙箱 × 审批组合，并改变模型可见的 Full access 行为。

**使用确定性的工具类别或路径规则。** 未采用，因为授权取决于用户任务、精确参数，以及删除、外部发送、生产变更或安全控制变更等实际效果。静态 allowlist 无法表达该语义范围，而且 Auto 有意不提供只读 fast path。

**审查完整 transcript 或 live 进程状态。** 未采用，因为 assistant 推理、工具结果、Git 状态、环境值与可变注册表可能提供无关或可伪造的授权，并使回放与执行不一致。已记录的五分区请求为每项接受的事实保留单一来源，并在无法重建时以拒绝方式关闭。

**只审查外层 `run_code` 调用。** 未采用，因为程序文本不能标识精确的 inner tool、schema、参数或实际开始的调度调用。逐项审查 inner dispatch 可以保留普通 PTC catch 与结算语义，同时授权真实效果。

**增加缓存 grant、重试、策略配置、审计事件或人工 fallback。** 第一个版本不采用，因为每项机制都会在单次二元调用决定之外增加持久授权、恢复或优先级规则。重复动作会重新接受审查，提供方或协议失败则会被拒绝。

**在每种宿主与默认值选择器中暴露 Auto。** 未采用，因为只有 shipped Web 组合完整装配 integration 与面向用户的拒绝读取方。扩大表面会让其他宿主持久化这一身份，却没有安全运行所需的生命周期与展示。

## 后果

用户获得一个当前会话选项，可以在没有沙箱或重复人工提示的情况下批准普通工作，同时仍针对已记录授权检查每项实际调用。主 agent 的提示词、工具 schema、Full access 叙述与拒绝文本保持不变，原生与 PTC 路径共用一个结构化拒绝身份。代价是每项实际调用都会增加一次模型请求，存在概率性的误放行与误拒绝，错误放行后没有额外保护，而且支持边界有意限于 shipped Web。严格的日志输入规则还会在必需历史或 schema 事实不可用时拒绝调用，即使 live 进程状态可以猜测该动作。

## 相关资料

- [拦截扩展点](2026-06-30-interception-extension-points.zh.md)——Auto 使用的有序 Tool 策略流水线。
- [审批 seam](2026-07-06-approval-seam.zh.md)——Auto 不扩展的独立一次性人工决定路径。
- [沙箱](2026-07-06-sandbox.zh.md)——Auto 复用其 Full access 旋钮的隔离模式。
- [PTC mode](2026-06-15-ptc.zh.md)——Auto 保持不变的程序传输与 inner dispatch 语义。
