---
description: "通过 Anthropic Messages 调用 DeepSeek，支持流式思考、工具、内联图片和持久化回放。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-deepseek-messages

[English](README.md) | 中文

## 概述

通过 Anthropic Messages 端点使用 DeepSeek，并保留 Harness 工具和 Session 历史。`deepseek-messages` 路由可与 Chat Completions 和 pi-ai 适配器同时运行。连接配置和凭据在下一次请求生效。图片采用受预算限制的内联 base64 内容。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 Cordis 组合中将本插件与 `dsh-llm` 一起挂载，并选择 `provider: deepseek-messages`。模型 ID 原样发送，目录仅供发现使用。

[Web profile](../../bundle/web-app/README.zh.md) 包含本适配器但默认禁用，使用 Chat Completions。启用后，**DeepSeek** 卡片使用 `DEEPSEEK_API_KEY`；端点和模型修改通过 `llm-deepseek-messages` 即时生效。提供方 ID 保持为 `deepseek-messages`，与显示名称相互独立。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-llm-deepseek-messages'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
    baseURL: https://api.deepseek.com/anthropic
    thinking: enabled
    reasoningEffort: high
    maxTokens: 256000
    streamIdleTimeoutMs: 300000
```

`baseURL` 是协议根地址，适配器会追加 `/v1/messages`。网关根地址不要包含 `/v1/messages` 或末尾的 `/v1`。显式配置优先于 `DEEPSEEK_MESSAGES_BASE_URL`，最后使用 DeepSeek 公网默认值。本插件不读取 `ANTHROPIC_API_KEY` 或 Chat Completions 的端点变量。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | 凭据引用；通过 credentials 服务解析，服务未挂载时读取启动环境 |
| `thinking` / `reasoningEffort` | enabled / high | `off`、`low`、`high`、`max`；禁用思考的部署仅允许 off |
| `models` | V41 Flash、V4 Flash、Pro、Flash Vision Exp | 发现目录及模型容量、图片配置覆盖 |
| `maxTokens` / `defaultContextWindow` | 256000 / 1000000 | 默认输出上限和上下文容量 |
| `maxInlineRequestImageBytes` / `maxImagesPerRequest` | 20 MiB / 600 | 保留的 base64 字节数和图片出现次数 |
| `streamIdleTimeoutMs` | 300000 | 等待服务端响应的最长空闲时间 |

[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-llm-deepseek-messages) 列出全部字段。`llm-deepseek-messages` 设置节覆盖组合字段；无效的一代设置会保留上一份完整有效连接。每次请求持有同一份设置快照，其中包含凭据引用。

### 请求行为

工具采用原生 `tool_use` 和 `tool_result` 内容块。相邻用户消息会合并，并将工具结果放在前面，保留调用 ID。思考强度使用 `output_config.effort`；标题请求禁用思考。开启思考时传入 temperature 会以 `UNSUPPORTED_OPTION` 失败。

未声明历史追加能力时，最后一条 system 消息提供完整的顶层 `system` 提示词，也适用于携带多版快照的直接调用。最后一条快照为空时，清空历史提示词。代理循环在继续或恢复这些路由时，也会将更新归并到系统头节点；从支持追加的路由切换过来时也如此。单次调用的 `GenerateOptions.system` 仍作为独立前缀。非文本 system 内容会被拒绝。

仅当端点与模型将最后一次 system 更新视为完整的有效提示词时，设置 `models[].systemPromptUpdate: in-history`。默认的 `deepseek-flash` 条目（DeepSeek-V41-Flash）启用该能力，并接受文本和图片；V4 与未列入目录的模型不启用历史内 system 更新。自定义 `models` 列表会替换默认目录。支持该能力的路由将初始提示词保留在顶层字段中，把后续快照序列化为原生 `role: system` 消息。[Anthropic 位置规则](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages)要求更新位于用户轮次（包括全部工具结果）之后、下一条助手消息之前。适配器将循环较早接纳的 system 映射到该位置，不改写持久化消息或对话轮次的相对顺序。缺少前置用户轮次的更新、空的历史内更新会被拒绝；循环负责的清空操作会在序列化前归并历史。

```yaml
models:
  - id: my-model
    systemPromptUpdate: in-history
```

视觉路由将持久化附件转换为确定性的请求图片，单图默认目标为 640000 像素和 1 MiB。规范化前按持久化字节数移除最旧图片，随后按实际编码字节数再次检查。保留的图片带有标准附件描述；工具结果中的图片保留在该结果内部。未列入目录和纯文本路由使用共享的附件文本投影。

成功响应在标准 assistant 内容块旁持久化最小原生回放元数据。同模型签名原样回传，包括空思考块的签名。跨模型或外部历史发送思考文本但不借用签名。不可用的原生回放元数据会被忽略并记录警告；持久化内容保持不变，思考文本不附带签名。完整响应中损坏的工具 JSON 会被拒绝，达到 token 上限的截断则由共享组装器移除未完成工具调用。

传输和服务端错误映射为稳定的 `LlmError` 代码，包括 `AUTH`、`QUOTA`、`RATE_LIMIT`、`CONTEXT_WINDOW_EXCEEDED`、`INVALID_REQUEST`、`SERVER`、`TIMEOUT` 和 `ABORTED`。缺少凭据在 HTTP 前失败。`message_stop` 之前断流会得到 `STREAM_CLOSED`。重试由 `llm-retry` 负责，适配器自身不重试模型请求。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

适配器分离[配置](src/config.ts)、[历史转换](src/serialize.ts)、[图片投影](src/images.ts)、[流转换](src/translate.ts)和[原生回放](src/replay.ts)。SSE 分帧由 `eventsource-parser` 负责。每次请求使用一个取消控制器和空闲监视器，消费者停止时关闭读取器。Chat Completions 包仅提供其公开的 DeepSeek 图片 token 计算器；导入它不会挂载其 provider。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [LLM 服务](../llm/README.zh.md)——provider 注册和流协议要求。
- [Chat Completions 适配器](../llm-deepseek/README.zh.md)——DeepSeek Files 支持。
- [Messages 决策](../../../.agents/notes/implemented/feature/2026-09-07-deepseek-messages-adapter.zh.md)——协议和回放选择。
- [DeepSeek 兼容性](https://api-docs.deepseek.com/zh-cn/guides/anthropic_api)——服务端支持的字段。

<a id="model-experience"></a>
## 模型体验

### Messages 请求与响应

#### 模型看到什么

模型接收组装后的系统提示词、有序文本/思考/工具历史、工具 schema 和保留的内联图片。原生签名在历史思考序列化前仅作为适配器元数据保存。思考文本不会转换为普通回答。图片描述和移除占位文本采用共享附件投影。

#### Token 影响

usage 计数为累计且互斥的未缓存输入、缓存读取、缓存写入和输出。适配器在 finish 前发送 usage，并由这些计数计算总量。图片计价复现基于持久化字节数的移除决策；实际编码后进一步移除可使估计下降。思考占用输出上限，回传时也增加后续输入。

#### KV Cache 影响

稳定的消息顺序和原样思考有助于保留可复用前缀。历史内更新保留初始系统字段和此前的对话前缀；普通替换或清空可能使该前缀失效。端点或模型变化、工具 schema、图片移除以及执行环境路径变化也可能使前缀失效。适配器不发送 Anthropic 缓存控制提示，因为 DeepSeek 会忽略它们。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

本适配器实现 DeepSeek Messages 子集：

- 图片仅以内联形式发送；Files 上传、缓存和过期管理留待后续实现。
- 不支持原生服务端工具、脱敏思考、document 内容块和结构化输出。
- Harness 请求接口未提供 `tool_choice`。DeepSeek 忽略 `tool_result.is_error`，错误正文仍原样传递。
- Messages 请求不附加 DeepSeek 请求扩展上传。网关特定支持需要单独验证。
- 未知模型 ID 原样发送；DeepSeek 可能将不支持的 ID 替换为默认模型。

**运行时不变量：** 不发布伴随检查器：除 LLM 流与注册要求外，适配器不拥有可独立观测并发生偏离的可变关系。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
