# Agent Note: 内联 Visualizer Cordis 扩展

Status: implemented

[English](2026-08-29-inline-visualizer-cordis-extension.md) | 中文

## 问题

DSH 缺少一方 Host 契约，让模型请求临时内联视觉内容、渐进加载构建指南，或让兼容 Client 从成功的 HTML widget 提交带明确标记的 follow-up。如果全局加入这组接口，即使 renderer 或权威服务不存在，也会改变每个 Agent preset。

## 决策

`@deepseek-ai/dsh-tool-visualizer` 是一个可独立装载、默认休眠的 Host／模型能力，包含两个 Cordis entrypoint。根 service 拥有 Host 源码与完整 follow-up 限额、准确 live Agent 与准确成功 `show_widget` result 的授权、权威的每 Agent follow-up 频控，以及已授权 widget-authored follow-up 的写入。result 授权使用直接 Session event 查询，而不是 call-ID 缓存。它生成的 Remote 向单独提供的兼容 Client 暴露 `sendPrompt`；Client 渲染限额是独立的安全上限，而非通过传输获得的 Host 配置。

同一包的 `./model` function-plugin 要求 `systemPrompt` 与 `tools`，然后可恢复地注入 `visualizer`；权威存在时，它只在 Agent preset standing scope 安装 `tool:visualizer` 提示词，以及 `widget_guidelines` 与 `show_widget`。`standard` 与 `cordis` 始终挂载该 wrapper，因此权威稍后出现、撤销与再次出现会针对现有及新 Agent 激活、移除与重新激活模型面。`minimal` 与 `ptc` 不包含该 row，因为 PTC 的嵌套 code-dispatch 日志不提供 follow-up bridge 所需的普通 `show_widget` call/result 身份。默认 application composition 均不挂载根权威，因此正式默认提示词与工具面保持不变。

每个 `widget_guidelines` result 都会在 `show_widget` 可见时包含 Delivery，再把一个共享 Foundation 与所请求的类型模块组合起来。Foundation 拥有宿主原生构图、响应式流、主题使用与跨类型可访问性；类型模块分别拥有 diagram 结构、交互生命周期、chart 语义与 illustration 例外。

挂载根权威后会同时公开 raw SVG 与 HTML fragment；源码前缀检测记录 kind，而不在模型可见 schema 中暴露 renderer 部署策略。本次变更不提供展示 Client，也不在 Web、headless 或 TUI 中激活该能力。Host 不提供可变状态上报、恢复或模型读取面。实现不新增 Visualizer session event、Agent loop 规则或 core schema。

## 验证

定向测试固定了共享路由提示词、统一 schema 与 guideline、源码和完整 follow-up UTF-8 限额、通过直接 event 查询完成的准确 Agent 与成功 result 授权、每 Agent prompt 限额，以及 root/model dispose。REAL Loader composition 测试证明默认 Web 与 headless profile 都不含权威，`standard` 与 `cordis` 始终挂载休眠的 model wrapper，`minimal` 与 `ptc` 没有该 row；权威稍后出现、撤销与再次出现时，现有和新 Agent 的继承模型面都会随之更新，而且不会增加全局工具或提示词 section。

## 考虑过的替代方案

**从根 service 注册工具。** 不采用，因为这会让模型策略变成部署全局状态，并绕过 preset 继承与 child 工具过滤。始终挂载的 `./model` wrapper 把权威留在 Host 根层，把模型可见性留在所属 preset scope。

**在默认 application composition 中启用能力。** 不采用，因为本次变更不包含展示 Client。默认休眠让 Host／模型契约可以独立评审和装载，而不会声称已有端到端用户体验。

**不检查 session 日志，直接信任 Client 提交的 call id。** 不采用，因为展示 Client 不能自行生成授权。每个 follow-up 进入 inbox 前，Host 都会把它绑定到准确 live Agent 与一个成功记录的 HTML `show_widget` result。

## 后果

该能力的改动收在一个包、2 条 preset wrapper row、生成式 catalog 与 TypeScript aggregate 中。默认 application 保持原有模型面。根 service 决定始终挂载的 wrapper 是否暴露模型面；端到端用户体验还需要兼容 Client。无需重建 preset 即可挂载、撤销或恢复该权威。Client 必须为所接纳的 HTML 自行提供渲染安全与资源控制。可变 widget 状态只存在于 Client，并会在其 document 重建时重置。
