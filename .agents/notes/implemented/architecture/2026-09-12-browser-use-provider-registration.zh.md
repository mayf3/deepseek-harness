# Agent Note: 浏览器操作提供方注册与 Session 所有权

Status: implemented

[English](2026-09-12-browser-use-provider-registration.md) | 中文

## 问题

浏览器控制后端暴露不同的操作与观测格式。在可移植消费方存在之前，通用浏览器动作 API 会约束这些实验。浏览器会话可以隔离，而附加现有已登录浏览器必须保留其状态，并防止一个提供方内出现并发所有权。

## 决策

[`dsh-browser-use`](../../../../packages/browser-use/browser-use/README.zh.md) 拥有 `ctx.browserUse`，注册一个提供方拥有的名称并返回其 effect 清理器。第二次注册无论名称为何都会失败。服务不包含浏览器对象、共享操作类型、分派方法、资源生命周期或运行时选择器。[计算机操作注册决策](2026-09-12-computer-use-provider-registration.zh.md)仍独立拥有桌面提供方注册与共享桌面协调规则。

[Playwright MCP](../../../../packages/experimental/browser-use-playwright-mcp/README.zh.md)、[Chrome DevTools MCP](../../../../packages/experimental/browser-use-chrome-devtools-mcp/README.zh.md) 与[原生 Stagehand](../../../../packages/experimental/browser-use-stagehand-native/README.zh.md) 拥有自己的浏览器工具，并通过常规 DSH 工具管线集成。它们是公共实验性可选功能。DSH 拥有任务规划与任务循环；Stagehand 提供单项 AI（人工智能）辅助操作。Profile 或 preset 配置为每次提供方激活选择启动或附加模式。

浏览器资源属于确切的实时 Agent 与 Session，而非仅凭可复用的 Session id。调用跨轮次保留状态。运行时释放会关闭启动的资源，重新加载或 fork 不会继承启动的 profile。附加保留现有浏览器状态，并在该提供方实例内将外部浏览器独占保留给一个 Session。清理断开连接而不关闭外部浏览器。

[实验性运行时辅助库](../../../../packages/experimental/browser-use-runtime/README.zh.md)拥有共享资源生命周期与附加保留机制，而不向浏览器操作服务引入这些方法。取消调用方对资源获取的等待后，初始化及其保留仍归 Session 所有。活动操作收到 Agent 释放的取消信号时，在 Agent 等待空闲之前启动资源关闭，因为浏览器调用可能只有在连接关闭后才能结束。提供方清理停止接收工具调用，并保留注册，直到资源清理、活动调用及辅助推理日志记录完成。服务保持独立于所有实验包。

Stagehand 的启动器继承其进程环境，SDK 初始化可能在清理完成前超时。提供方 Host 使用 `@puppeteer/browsers` 在 CDP 或 SDK 就绪前取得所启动 Chromium 及其临时 profile 的所有权，并清理子进程环境。启动和附加模式都由隔离的 Worker 运行 SDK，且只通过 CDP 连接。普通操作取消会关闭该 Worker，但保留浏览器和 Session 保留状态；下一次操作按需重新连接。Session 或提供方清理尝试释放 Stagehand 状态，然后终止 Worker 以关闭其套接字。Host 仅终止自己拥有的 Chromium 进程，等待子进程关闭后才删除 profile；外部拥有的浏览器保持运行。

Stagehand 使用受支持的自定义模型回调，通过 Session 选定的 DSH 模型请求结构化结果。提供方内的适配器请求一个结果工具调用，并依据 Stagehand 请求的 JSON Schema 验证其参数；它不执行额外的模型工具调用。辅助请求在模型分派前记录并刷新，已结算响应在自动化继续前记录并刷新。这些事件保持独立于主对话，在不改变 agent loop（智能体循环）的情况下保留浏览器操作的模型输入。

MCP 客户端激活会等待连接和工具发现，但提供方可能在任何 Session 存在之前就完成激活。该激活 promise 无法代表未来各 Session 拥有的客户端。每个 MCP 浏览器提供方观察后续的 `agent/created` 发布，并立即占用 Agent 现有的 `runMaintenance` 阶段，执行一次客户端启动尝试。维护在轮次之外运行，并将输入保持在队列中直到发现结束，使常规提示词组装读取完整目录。直接调用方在检查提示词组装或作用域工具前等待 `agent.whenIdle()`。

启动失败会保留为本次激活的失败状态，并拒绝提示词组装和模型请求。附加连接被占用时，本次激活永久跳过启动，但其他工作继续运行；连接释放后，新创建或恢复的 Agent 可以获取连接。较晚安装和重新加载只作用于后续激活，与 [Schedule 的挂载策略](../../../../packages/schedule/schedule/README.zh.md#use-this-package)一致。成功客户端的浏览器工具与资源请求共享 Session 队列；其他 Session 不能执行这些请求，也不能收到该服务器的指导。

## 考虑过的替代方案

**统一浏览器动作 API。** Playwright、Chrome DevTools 与 Stagehand 的原生语义不同。当前没有消费方要求可互换的动作方法，因此由提供方拥有工具以保留这些语义。

**新增核心启动 API。** 现有 Agent 维护阶段已能在 Session 自有设置期间阻止轮次运行；另一个初始化 API 会重复这份所有权。

**在提示词组装期间发现。** 提示词和工具收集需要已就绪的注册。此时启动发现要么暴露不完整目录，要么要求再次收集；维护在轮次开始前完成发现。

**多个 Session 共享一个浏览器。** 浏览器标签页、导航与登录状态可以按 Session 隔离。共享它们会引入桌面集成通常无法避免的跨 Session 干扰。

**附加时创建全新 context。** 新浏览器 context 不继承现有登录状态。独占使用附加的浏览器可保留附加所支持的工作流。

**随 Session 恢复浏览器 profile。** 持久浏览器状态引入 Session 日志之外的 profile 存储与迁移所有权。启动的状态仅在实时运行时存续；外部拥有的浏览器保留自己的持久化策略。

**仅支持隔离启动。** 用户既需要干净的浏览器会话，也需要访问现有身份验证状态。配置显式选择所有权策略。

**委托浏览器 agent。** 这些实验比较浏览器控制后端。将整个任务委托给另一个规划器会改变 DSH 对任务循环的控制。

## 影响

提供方独立演进自己的工具，而共享服务保持仅注册名称。三个提供方及其运行时辅助库作为实验性包发布，但不在内置默认配置中启用。浏览器包组不依赖实验性运行时代码。

附加保留机制作用于单个提供方实例；它不协调独立 DSH 进程或外部浏览器客户端。Session 重放不包含浏览器状态，取消不会撤销已交付的浏览器操作。提供方 README 拥有引擎支持、模型要求与上游限制。
