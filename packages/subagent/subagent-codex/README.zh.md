# @deepseek-ai/dsh-subagent-codex

[English](README.md) | 中文

本包注册由 Profile 命名、默认名称为 `codex` 的 Codex subagent 提供方。每次接受运行请求后，它都会在发起委托的会话工作区中启动官方 `codex app-server --stdio` 命令，创建一个临时 Codex 线程，提交一个自包含的文本任务，并通过共享的 [`dsh-subagent`](../subagent/README.md) 结果约定返回选定的最终答案或安全失败说明。

## 启动与所有权

`start(request)` 只接受非空的文本块序列，并根据父会话确定子级 cwd。随后，它通过 [`dsh-subprocess`](../../subprocess/subprocess/README.md) spawn 固定命令，依次执行 `initialize` → `initialized`，把 Profile 选择的模式映射为官方 `thread/start` approval／reviewer／sandbox 字段并与 `{ cwd, ephemeral: true }` 一起发送，且仅在 Codex 返回有效的临时线程后才发布此次运行。若在发布前发生失败或取消，它会关闭通信链路、终止受管进程树并等待其退出，然后拒绝 `start()` 调用。

已发布的 `run.result` 恰好启动一个轮次。它只接受与此次运行的线程和轮次匹配的通知，随后等待权威的终止通知 `turn/completed`。以最后一条 `phase: "final_answer"` 的 `agentMessage` 为准；若 Codex 没有发出明确的最终阶段，则以最后一条 `phase: null` 的消息作为兼容性回退。过程说明绝不会取代上述任一答案；成功完成的轮次若没有非空白答案，结果也会判为错误。

对于命令与文件审批，无人值守的提供方会从请求给出的决策选项中选择一项不予批准的决策，并优先选择 `cancel`；稳定的 0.147.0 请求形态没有决策选项列表，因此回退到 `decline`。它对权限请求返回作用域限于当前轮次的空权限集，不向用户输入请求提供任何答案，并拒绝 MCP elicitation。若请求在无人值守模式下没有合法响应，或是未知服务器请求，此次运行就会失败。wire 只记录有效模式、请求类别、决定与固定的安全原因，也会识别被拒绝的命令／文件 item 和 `sandboxError` 终态。Codex 0.147.0 的部分早期 `never` 拒绝和 sandbox violation 只写入结构化 stderr，因此提供方会 pipe stderr、原样转发给 Host，并在每次运行的有界尾缓冲中匹配两个固定签名；原始 stderr 不会进入诊断。

本地取消会在结果竞态中胜出并映射为 `aborted`。失败轮次的 `codexErrorInfo` 若为 `contextWindowExceeded`，则映射为 `max-tokens`；其他任何远端中断或失败轮次都映射为 `error`，且该提供方不会产生 `refusal`。权限相关错误可以额外携带有界、非 assistant 的 `SubagentResult.diagnostic`；成功和本地取消不会附带它。`dispose()`（资源释放）具有幂等性：如果当前的两个标识符均已知，它会尽力请求 `turn/interrupt`，关闭 JSON-RPC 通信链路，结束标准输入，调用共享的进程树逐级终止机制，等待整棵进程树退出，并移除 stderr observer。结果失败与独立的清理失败仍彼此分离。

## 能力与上下文

本提供方不声明任何可选的启动时能力，并报告 `inheritsParentContext: false`。Codex 会接收独立文本任务和父会话 cwd，但不会接收父会话的对话、角色设定、工具筛选器、深度策略或结构化输出约定。临时 Codex 线程 ID 与轮次 ID 仅在此次运行内部可见，绝不会持久化到父会话。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `providerName` | `codex` | `ctx.subagents` 中的非空注册名称；每个已挂载实例都需要唯一值。 |
| `env` | `{}` | 显式指定的子进程环境，叠加在由子进程 seam 清除凭证后的父环境之上。 |
| `permissionMode` | `never` | 为该提供方实例的每个线程固定原生非交互审批与沙箱模式。 |
| `disposeGraceMs` | `3000` | 共享进程树责任方各终止层级之间的宽限期，单位为毫秒且须为正有限值，并不得大于仓库共享的 [`MAX_TIMER_DELAY_MS`](../../util/timeout/README.md)；随后资源释放会等待整棵进程树退出。 |

| `permissionMode` 值 | `thread/start` 字段 | 原生行为 |
|---|---|---|
| `never` | `approvalPolicy: never`；省略 sandbox | 永不请求审批；执行失败会在原生 sandbox 下返回模型。 |
| `approve-for-me` | `approvalPolicy: on-request`、`approvalsReviewer: auto_review`、`sandbox: workspace-write` | 由 Codex 自动评审权限请求，不等待人工。 |
| `dangerously-bypass-approvals-and-sandbox` | `approvalPolicy: never`、`sandbox: danger-full-access` | 跳过审批与 sandbox；必须显式选择该值。 |

生产环境会从 `PATH` 中解析 `codex`，并使用宿主机原生的 Codex 配置与身份验证。提供方只覆盖选定线程的 approval／reviewer／sandbox 字段；其他 `CODEX_HOME`、项目、模型、provider、MCP、hook、skill 与账户设置仍由原生机制负责。本插件不安装 Codex、不选择模型、不创建 `CODEX_HOME`、不执行登录，也不探测版本。子进程 seam 会移除具有凭证特征的环境变量，因此供子进程使用的 API 密钥必须在 `env` 中显式提供；除非被覆盖，`PATH` 和 `HOME` 等普通环境变量值仍然可用。

生产 `dsh` 不会安装或挂载这个可选提供方。选择启用它的 Profile 必须安装 `@deepseek-ai/dsh-subagent-codex`，并可在 host plane（宿主平面）挂载一个或多个具有不同 `providerName`、`permissionMode` 与 `env` 的配置项；省略 `providerName` 时仍使用默认的 `codex`。加载实例本身不会在绑定工具调用前启动 Codex 进程。每个 `dsh-tool-subagent` 配置项指定一个提供方，并需要独立的 `toolName`，因此模型看到的是静态工具，而不是动态提供方选择器。完整 Agent Preset 携带对应的默认产品工具行并设置 `disabled: true`；复制一个 preset 后删除该字段，即可只向由该副本组装的 agent 暴露 `subagent_codex`。其 `one-shot` 策略会让省略 `run_in_background` 或传入 `false` 的调用继续在前台等待，而显式传入 `true` 会返回由父 agent 拥有的 Job ID，供 `job_output` 或 `job_kill` 使用。base host（基础宿主）与完整 preset 已提供通用作业注册表和控制工具。

下列独立组装展示完整的显式能力。基于 `@deepseek-ai/dsh-base` 的 Profile 保留已有 Job 配置项，新增产品提供方与工具配置项，而且不重复挂载 Job 服务。

```yaml
- id: subagent-codex-safe
  name: '@deepseek-ai/dsh-subagent-codex'
  config:
    providerName: codex-safe
    permissionMode: never
    env:
      OPENAI_API_KEY: !!js process.env.OPENAI_API_KEY

- id: subagent-codex-bypass
  name: '@deepseek-ai/dsh-subagent-codex'
  config:
    providerName: codex-bypass
    permissionMode: dangerously-bypass-approvals-and-sandbox
    env:
      OPENAI_API_KEY: !!js process.env.OPENAI_API_KEY

- id: jobs
  name: '@deepseek-ai/dsh-jobs-local'

- id: tool-jobs
  name: '@deepseek-ai/dsh-tool-jobs'

- id: tool-subagent-codex-safe
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: codex-safe
    toolName: subagent_codex_safe
    backgroundMode: one-shot
    maxDepth: provider-managed

- id: tool-subagent-codex-bypass
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: codex-bypass
    toolName: subagent_codex_bypass
    backgroundMode: one-shot
    maxDepth: provider-managed
```

## 产品兼容性与证据

生产环境的协议层有意只实现这一单次执行约定所需的 app-server 方法。开发证据锁定在 `@openai/codex@0.147.0` / `codex-cli 0.147.0`；该 NPM 包仅作为测试依赖，部署环境仍需通过 `PATH` 提供 `codex`。真实产品覆盖会证明两个命名实例保留彼此独立的环境与原生模式，线程级 `never` 覆盖环境中的 `on-request`，自动评审通过官方 app-server 启动，危险绕过只在测试拥有的临时存储中写入，安全诊断不包含原始命令与路径，而且所有 wrapper／native 进程都会退出。

## 模型体验

### 子级请求

#### 模型看到的内容

Codex 子级会在一个全新的临时线程中，以单个轮次接收这些独立文本块。它的工作区是父会话 cwd；其模型、系统指令、工具和身份验证来自原生 Codex 安装与配置，而所选提供方实例的 Profile 配置会固定该线程的环境、非交互审批策略与沙箱模式。

#### 对 token 的影响

子级需为独立的 Codex 上下文和轮次承担 token 开销。子级 token 不会进入父级上下文。

#### 对 KV Cache 的影响

这与父请求缓存相互独立。能否复用只取决于 Codex 自身的提供方、模型、指令、工具和临时线程请求。

### 父级调度与结果（间接）

#### 模型看到的内容

通过 `dsh-tool-subagent`，前台调用会让父级模型看到选定的 Codex 最终答案；若结果未完成，错误中会包含终止原因和可选的安全诊断。后台调用会先返回 Job id；随后通用作业控制面会送达完成通知，通过 `job_output` 公开最终答案或失败状态 detail，并允许 `job_kill` 请求取消。Codex 的过程说明、推理（reasoning）、工具活动、原始 stderr、工作区差异、用量信息、产品标识符、命令、路径和协议载荷均不会复制到父会话。

#### 对 token 的影响

前台输入会增加工具结果中保留的最终答案或错误内容。后台输入还会包含启动确认、完成通知，以及 `job_output`、`job_kill` 或后续状态结果；子任务 token 仍不会进入父级上下文。本提供方自身不添加父级工具 schema。

#### 对 KV Cache 的影响

仅追加：前台会在可复用的父请求前缀后增加一个结果，后台则会继续追加 Job 启动确认、通知以及后续控制或收集结果。后台调度可能增加一个由通知唤醒的轮次，但这些消息都不会改写更早的前缀。

## 已知限制与后续工作

- **每次运行均新建一个进程、一个线程和一个轮次**：不支持续接、恢复、池化、进度流或产品会话持久化。
- **静态选择实例**：Profile 配置项固定提供方名称与工具绑定；调用无法动态选择提供方，而且每个公开工具都需要唯一的 `toolName`。
- **产品安装和账户状态由宿主管理**：`codex` 缺失或不兼容、配置错误或身份验证失败，都会呈现为启动错误或运行错误；本插件不提供安装程序、登录流程或运行时版本门禁。
- **兼容性由开发证据锁定**：若要从已验证的 0.147.0 协议基线升级，必须重新生成上游 schema 证据，并重新运行握手、答案选择、审批、取消、无密钥真实产品以及带密钥的 DeepSeek 随机数测试。
- **没有人工审批路径**：已知的无人值守审批请求会被拒绝，未知服务器请求会以默认拒绝方式使运行失败；三种 Profile 模式都不会创建 DSH 交互通道或逐次调用 allow 策略。
- **assistant 载荷仅包含最终文本**：失败运行可以额外公开独立的安全诊断；推理、过程说明、中间消息、工具通信、用量信息、原始 stderr 和工作区差异不会进入父会话，通用 Job id、通知与状态来自共享作业运行时。
- **没有可选的共享能力**：对于本提供方，共享服务会拒绝输出 schema、子任务角色设定、工具筛选和 harness 深度强制约束。
- **没有按实际经过时间触发的超时或副作用回滚**：长时间运行的工作由调用方取消，且取消前已更改的文件或外部系统不会恢复原状。
