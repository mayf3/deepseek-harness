# MCP

[English](mcp.md) | 中文

## 摘要

模型上下文协议（Model Context Protocol，MCP）让模型使用外部服务器提供的工具。每个已配置服务器都会提供普通 Harness 工具，支持取消、权限检查、结果记录和受支持的图像输出。官方 SDK 协商现代或受支持的旧版协议。本参考页介绍 MCP 包组的职责、作用域和组合选择；服务器配置由[客户端 README](../../packages/mcp/mcp-client/README.zh.md) 维护。

## 目录

- [配置](#configuration)
- [职责与作用域](#responsibilities-and-scope)
- [协议与结果](#protocol-and-results)
- [限制](#limits)
- [延伸阅读](#further-reading)

-----

<a id="configuration"></a>
## 配置

MCP 需要显式启用。在目标 Cordis 作用域中，为每个服务器挂载一个 `@deepseek-ai/dsh-mcp-client` 条目。组合提供[工具注册表](tools.zh.md)；MCP 客户端拥有自己的连接和已发现工具。

| 选择 | 配置维护位置 |
|---|---|
| 服务器身份、本地进程或 HTTP 端点、凭据和进程环境 | [客户端配置](../../packages/mcp/mcp-client/README.zh.md#use-this-package) |
| 工具调用超时、启动失败策略和重连 | [客户端配置](../../packages/mcp/mcp-client/README.zh.md#use-this-package) |
| 权限决策和受支持的图像输出 | [工具执行](tools.zh.md)和[附件](attachment.zh.md) |

协议协商遵循 SDK 支持的修订版；产品没有强制指定协议修订版的设置。[配置目录](../config-catalog.zh.md#deepseek-aidsh-mcp-client) 列出客户端接受的字段和默认值。

-----

<a id="responsibilities-and-scope"></a>
## 职责与作用域

客户端是每服务器一个的连接插件，也是 Harness 工具注册表的消费者。它不发布共享的 `ctx.mcp` 服务。外部服务器实现 MCP 操作；SDK 拥有协议交换；客户端将发现的工具适配到 Harness 执行过程。

配置的 `serverName` 在注册作用域内标识服务器。同一作用域中的两个条目不能占用相同名称；不同 Agent 作用域可以复用该名称。公开工具名包含配置的服务器名称，因此不同服务器的同名工具仍可区分。注册副作用拥有名称和已发现工具；插件释放时关闭连接并移除其贡献。

[原生 Cua Driver 提供方](../../packages/experimental/computer-use-cua-driver-native/README.zh.md) 复用客户端导出的结果适配器，无需打开 MCP 连接。桌面提供方选择属于[计算机使用子系统](computer-use.zh.md)。

-----

<a id="protocol-and-results"></a>
## 协议与结果

stdio 和 Streamable HTTP 都使用官方 SDK 的协商、发现、协议校验和取消机制。工具列表变化通过旧版通知或现代订阅触发发现。刷新失败时保留上一代工具；连接恢复遵循[客户端生命周期](../../packages/mcp/mcp-client/README.zh.md#use-this-package)。

结果适配器为程序化调用方保留规范 MCP JSON，并准备普通工具内容。受支持的图像使用附件系统；不受支持的富内容产生明确的文本诊断。工具注册表仍决定策略失败和结果替换。[工具契约](tools.zh.md) 维护记录和最终呈现规则；[客户端结果参考](../../packages/mcp/mcp-client/README.zh.md#use-this-package) 维护 MCP 特有的投影细节。

-----

<a id="limits"></a>
## 限制

该组合提供服务器工具，不提供 MCP 资源、服务器指令、提示词模板、人工输入征询或基于任务的执行。没有工具能力的服务器以空工具集连接。连接和发现超时遵循 SDK；客户端没有对应的独立设置。

-----

<a id="further-reading"></a>
## 延伸阅读

- [MCP 包组](../../packages/mcp/README.zh.md) — 包入口。
- [第三方记忆服务器](../user/guide/mcp-memory.zh.md) — 产品配置指南。
- [协议协商决策](../../.agents/notes/implemented/feature/2026-09-12-mcp-sdk-protocol-negotiation.zh.md) — SDK 职责与兼容性决策。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmcpresources--mcpresourceruntime"></a>

### `ctx.mcpResources` — `McpResourceRuntime`

Scoped resource access plus three tools shared by configured MCP servers.

```ts cordis-catalog
/**
 * Register one server in the caller's Cordis scope.
 * @param server - configured server name, unique in this scope.
 * @param provider - connection-owned resource operations.
 * @returns the effect disposer for this exact registration.
 */
register(server: string, provider: McpResourceProvider): () => void
```

Source: [`packages/mcp/mcp-resources/src/index.ts`](../../packages/mcp/mcp-resources/src/index.ts)
<!-- END GENERATED cordis-surface -->
