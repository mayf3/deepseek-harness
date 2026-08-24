# Agent Note: 用户授权的 subagent 模型路由

Status: implemented

[English](2026-08-24-user-authorized-subagent-model-routes.md) | 中文

## Problem

注册 LLM 适配器会使其路由可达，但不代表授权 Agent 为子级选择每一个可达模型。针对实时适配器注册表的单一启用偏好，会在另一个提供方或模型出现时静默扩大范围。产品需要一项显式且稳定的授权决定，同时避免把可能很大的模型目录渲染进父 Agent 的每次请求。

## Decision

Host 自有的 `subagent-model-selection` 设置 section 保存 `allowedModels`，即由精确 `{ provider, model }` 路由组成的数组。空数组会关闭面向模型的子级路由选择。Plugins 设置卡通过 `llm.models` 读取实时适配器目录，让用户暂存一条或多条精确路由，再用一次带 revision 限制的字段写入整体替换该数组。它不保存适配器自有的显示名称、描述或推理强度元数据。当前目录中缺失的已存路由仍显示为不可用并允许移除；某个提供方的目录失败不会阻塞其他提供方，也不会清除已存授权。

新组合的顶层 Session 会在模型可选定义进入请求之前，把非空路由列表快照记录为 `subagent/model-selection-policy`。子 Session 从在线父级继承同一份精确列表，恢复的 Session 使用已记录事件而不是当前设置。因此，设置修改只影响之后组合的顶层 Session。

固定的 `list_subagent_models` schema 不会枚举该策略。调用时，提供方和模型列表是 Session 路由列表与适配器实时公布目录的交集。精确 provider/model 查询先要求授权，再解析适配器自有的模型元数据和全部已公布推理强度。委派执行器还会独立拒绝任何生效 provider/model 路由不在 Session 列表内的显式提供方、模型或强度选择，然后才由 `resolveCallConfig()` 校验适配器可用性与强度支持。完全没有选择字段的调用保留配置或继承路由，因为模型没有作出路由选择。

静态 `enableModelSelection: true` 继续作为自定义组合中由部署方所有的无限制模式。随附的 `modelSelectionSettings` 路径由用户授权且默认关闭。主 spawn 工具使用该路径；随附 fork 工具仍不公开路由选择，使继承的对话前缀继续符合提供方侧 KV Cache 复用条件。

## Alternatives considered

**在委派描述中渲染允许路由。** 不采用，因为很大或变化的列表会扩大每次请求，并使较早的提示词前缀失效。按需发现会保持固定 schema 的前缀稳定，且只在请求目录时记录其内容。

**只过滤设置 UI 或发现结果。** 不采用，因为模型可以猜测路由，或从较早的 transcript 中保留路由。授权由启动子级的执行器强制执行。

**把 `enabled` 与 `allowedModels` 存成两个字段。** 不采用，因为两次写入会产生已经启用但尚无完整授权决定的状态。非空数组同时表示 opt-in 与精确策略；用户层空数组可以显式关闭部署基础列表。

**保存每条路由的推理强度允许列表。** 不采用，因为用户决定针对子级模型，而强度 id 与兼容性属于精确适配器路由。路由获准后，仍可使用适配器支持的每种强度。

**每次发现或委派调用都读取当前设置。** 不采用，因为设置编辑会静默改变运行中 Session 的模型可见能力和执行权限。持久 Session 快照会让恢复与子级继承保持确定。

## Consequences

- 新适配器注册和新公布模型不会扩大用户授权。
- 适配器移除或目录失败可以减少发现当前列出的内容，但不会删除已存路由决定；即使建议性目录省略某条精确已授权路由，只要适配器接受它，该路由仍然可用。
- 允许列表本身不消耗父级请求 token。只有 `list_subagent_models` 结果进入 transcript。
- 单元覆盖固定设置校验、Session 取样与继承、发现交集、执行器拒绝、UI 陈旧候选项、暂存后的整数组写入，以及写入被拒时保留草稿。组装 Web 场景固定真实设置文档与 Plugins 设置卡流程。

## Related decisions

路由参数、适配器预检、发现工具与 fork 缓存限制仍由[模型选择的 subagent 路由](2026-08-18-model-selected-subagent-routes.zh.md)负责。
