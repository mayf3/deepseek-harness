---
description: "逐工具 LLM 授权审查，供在 shipped Web 应用中使用实验性 Auto 权限预设的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-auto-review

[English](README.md) | 中文

## 概述

`dsh-auto-review` 让用户在当前 Web 会话不使用文件沙箱的同时，由独立 LLM 审查决定每次真实工具调用能否执行。每次原生调用与每次 PTC inner call 都会在工具主体开始前接受一次审查；外层 `run_code` 传输不会被审查。允许决定会继续走既有 Full access 执行路径，拒绝决定或 reviewer 故障则在工具主体前停止，并为 Web 工具卡保留结构化原因，但不向主 agent 暴露该原因。shipped Web 组合包是这一实验性预设唯一受支持的宿主；Headless、新会话默认值、General Settings 与 out-of-process child 都不会启用它。

## 目录

- [使用本包](#use-this-package)
- [运行真实模型认证](#run-the-real-model-certification)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当 shipped Web 用户接受 Full access 执行、但希望当前会话依据可用授权上下文检查每项实际工具动作时，可选择 Auto review。不要把它视作沙箱或确定性策略：reviewer 可能误放行或误拒绝，而每项获准动作都以 `danger-full-access` 和审批策略 `never` 执行。

### 挂载集成

shipped Web 组合包会在基础权限、Session、LLM 与 Tool 服务可用后，把该集成作为普通 Cordis 配置项挂载：

```yaml
- id: auto-review
  name: '@deepseek-ai/dsh-auto-review'
```

插件会在自身 effect 生命周期内调用权限服务固定的 `registerAuto(admit)` 钩子。权限服务拥有保留身份与 Full access 旋钮组合，而 shipped Web 客户端的 locale 字典拥有固定的 Auto label 与 description。用户可以通过 Web 选择器或 `/permission auto` 为当前会话选择 Auto，而它绝不会进入 `permission.defaultPreset` 的候选项。

本包不发布 runtime invariant 伴生插件，因为根插件的单个 effect 共同拥有授权与资源释放，不存在会与该生命周期发生分歧的独立观测。

### 审查与故障行为

reviewer 使用最新记录的提供方／模型路由，并接收五个分区：固定的 `REVIEW_POLICY`、Session 工作目录、当前项目指令、过滤后的历史以及待审动作。请求不会设置主 Session 的 `sessionId`，项目指令与历史条目也不携带事件 `seq` 坐标。带自身持久 `rpcId` 的 durable human 文本（`source.kind === 'user'`）定义或替换当前任务及明确限制。对于进程内 child，既有创建 prompt 与后续 `senderSessionId` 匹配 `parentSession` 的 `agent-message` 定义或调整委派任务，但不能覆盖 human 限制。当前 `agent-instructions` 只能约束；压缩 checkpoint 恢复有损语境；图片、附件与历史调用只提供事实。assistant 文本、推理与工具结果不会进入请求。

reviewer 按待审动作的实际效果分类，并返回一个封闭的 `risk + decision` 对象：low 必须 allow，medium 可以 allow 或 deny，high 必须 deny；只有 deny 可以携带字符串 reason。日志事实缺失或不一致、提供方故障、上下文超限、非法输出、非法 risk／decision 组合以及其他任何审查故障都会在工具主体前拒绝调用。调用方取消沿用普通 Tool 的结算优先级：late allow 后的取消会转为规范的 dispatch 前取消，而已经结算的拒绝或技术失败仍保持 Auto 拒绝。

<a id="run-the-real-model-certification"></a>
### 运行真实模型认证

设置 `DEEPSEEK_API_KEY` 后，从仓库根目录运行以下聚焦的显式启用测试：

```sh
DSH_AUTO_REVIEW_CERTIFICATION=1 pnpm exec vitest run --config vitest.e2e.config.ts packages/interaction/auto-review/tests/auto-review.e2e.ts
```

即使已有凭据，未设置 `DSH_AUTO_REVIEW_CERTIFICATION=1` 时该套件也会跳过。显式启用但缺少 `DEEPSEEK_API_KEY` 时，测试会以明确的配置错误失败。成功运行会以零重试方式精确执行 22 次 reviewer 调用：P01 为 low 的 allow／allow，P02–P04 为 medium 的 deny／allow，P05–P08 为 high 的 deny／deny；P02 还会走另一条执行路径，Pro 与 Vision 各运行一次 P02 配对。测试会在进程内同时断言 risk 与 decision，以 committed JSON Schema 校验脱敏报告，并只把 case／model／path、预期与实际 decision 及已验证 side effect 写到仓库外。可以用 `DSH_AUTO_REVIEW_CERTIFICATION_REPORT` 选择该外部路径。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

插件以前置方式注册一个 `tools/pre-execute` 监听器。它从可见的 `tool/call` 与最新 request-header schema 重建每个原生动作，并从对应的 `tool/code-dispatch-start` 快照重建每个 PTC inner action。当前动作只出现在 `PENDING_ACTION` 中；过滤历史只保留已经开始的历史调用。

Auto 拒绝使用固定模型可见消息，其中会指明被拒绝的工具并说明其主体未执行。其 `AutoReviewDeniedError`／`AUTO_REVIEW_DENIED` 身份与可选 raw reason 通过普通原生或 PTC 结构化错误字段传播。Web 树会在 keyed Tool 视图分派前识别该身份并渲染通用拒绝卡，因此专用或外部 Tool 视图都不能遮住拒绝结论。展示层只在渲染工具卡时归一化原因。

发布与资源释放都以拒绝方式关闭。发布前，integration 要求配置的 `read-only` 预设精确解析为沙箱 `read-only` 加审批策略 `ask`；同名但映射到其他组合的条目会被拒绝。持久 Auto 会话在 live Auto 注册缺失时不能发布。资源释放在修改任何预设前，会先捕获所有正在退出 Auto 的精确 Session 对象身份。监听器会先检查该集合，再派生当前权限状态，因此即使部分迁移已经追加 `permission/preset` 或 `sandbox/mode`，也不能重新开放 Tool 执行。插件随后关闭新准入，通过普通预设写入器把这些已捕获会话切换到 Read Only，再中止生命周期并等待每次在途审查或已准入调用。允许的调用会保持 active 状态，直至进入 `tools/execute` 或 `tools/result`；execute 包装层会在继续分派前合并生命周期 signal 与调用方 signal，因此资源释放会取消任何尚未开始的已准入工具主体。如果全部迁移成功，资源释放会移除监听器与 Auto 注册；如果任一迁移失败，Cordis 会报告清理错误并让两者保留在已关闭状态，使退役会话的后续调用继续被拒绝、新的 Auto 选择继续失败。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 固定 Auto 注册、五分区请求、严格决定解析器、pre-execute 监听器与资源释放 |
| [`tests/auto-review.spec.ts`](tests/auto-review.spec.ts) | 日志输入、决定、取消、原生／PTC、恢复与资源释放行为 |
| [`tests/auto-review.e2e.ts`](tests/auto-review.e2e.ts) | 显式启用的 22-call 真实模型认证，覆盖八组语义配对、两条执行路径与全部 shipped 模型 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [权限预设](../permission-presets/README.zh.md)——固定 Auto 注册与当前会话写入路径。
- [工具子系统](../../../docs/subsystems/tools.zh.md)——pre-execute 决定以及原生／PTC 结构化失败字段。
- [Subagent 子系统](../../../docs/subsystems/subagent.zh.md)——in-process 继承边界。
- [Auto review 决策](../../../.agents/notes/implemented/feature/2026-08-28-auto-review.zh.md)——依据、替代方案与验证证据。

-----

<a id="model-experience"></a>
## 模型体验

### 逐调用授权审查

#### 模型看到什么

reviewer 接收本包拥有的固定策略，以及一条包含 `ENVIRONMENT`、`PROJECT_INSTRUCTIONS`、`FILTERED_HISTORY` 和 `PENDING_ACTION` 的 user 消息。主 agent 不会收到 Auto 专用提示词、允许事件、结构化错误身份或 reviewer 原因；被拒绝的调用只会收到固定消息，说明具名工具被 Auto review 拒绝且其主体未执行。

#### Token 影响

Auto 中的每次原生调用与每次已经开始的 PTC inner call 都会进入一次审查操作。完整的日志请求会创建一次独立的同路由 LLM 请求，其输入长度取决于数据；缺失必需事实时会在联系提供方前拒绝。本包不会缓存、批处理、摘要、截断或重试审查。

#### KV Cache 影响

审查请求独立于主 agent 请求，不会改变其可复用前缀。固定 reviewer 策略可以在多次审查间形成稳定前缀，而四个数据分区会随 Session 和调用变化。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下限制界定实验性 Auto 预设及其受支持部署。

- **审查是概率判断，不是隔离**——获准调用以完整宿主访问权限执行，因此 reviewer 可能不安全地放行，也可能产生不必要的拒绝。
- **worker-thread 程序的直接效果不会被审查**——Auto 会委派外层 `run_code` 传输，只审查其 PTC inner call。shipped worker-thread 后端允许程序文本以与 bash 相当的宿主权限访问 Node API，因此直接产生的文件系统、进程、网络或其他 Node 效果都发生在 Auto review 之外。
- **支持范围限于 shipped Web 当前会话**——Headless、General Settings、未来会话默认值、任意宿主组合与 out-of-process child 都不暴露 Auto。
- **reviewer 只接收已记录的授权事实**——它不检查 Git 状态、环境变量、assistant 推理、工具结果或 live Tool 注册表；缺失必需事实时会拒绝调用。
- **没有策略定制或 fallback**——v1 只有一份固定策略，没有缓存、grant、独立重试层、审计事件或人工 fallback。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
