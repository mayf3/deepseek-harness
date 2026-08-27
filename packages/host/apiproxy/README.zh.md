---
description: "Host 启动元数据与 Session 日志 ZIP 流下载的旧版 HTTP 载体；普通业务操作由生成的 Typert Remote 持有。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-apiproxy

[English](README.md) | 中文

## 概述

`dsh-host-apiproxy` 承载尚不属于生成业务 Remote 的两项 Host 操作：`host.describe` 启动快照与流式 Session 日志 ZIP 下载。它的浏览器安全 envelope 与 fetch adapter 服务 HTTP 和进程内客户端，其余普通业务操作由 API Gateway 承载。随发行版交付的 Web 组合在 [`dsh-web-app`](../../bundle/web-app/README.zh.md) 中组装两种传输。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当 GUI Host 需要启动元数据与 Session 日志导出时组合本包：加载 `ApiProxyService`，把 `ctx.apiProxy` 包进一个载体，其他业务调用使用生成的 Remote。

### 选择载体

`toFetchHandler(api)` 把网关变成纯 WHATWG fetch 函数，供 HTTP 服务器使用（随发行版交付的 Web 组合把它暴露在 `/api/…` 路由之后）；`InProcessApiClient` 则在进程内运行同一条序列化与校验路径——这是需要完整协议路径但不需要网络的调用方与测试的同构接点。

```text
const client = new InProcessApiClient(toFetchHandler(ctx.apiProxy))
const response = await client.host.describe({})
```

HTTP 载体在分发前以 415 拒绝非 JSON 的 POST 请求体，因此跨站「简单请求」永远无法盲目执行有副作用的方法。浏览器载体对每个 Host API 方法实施相同的 Host/Origin 检查与签名 cookie 认证（[`dsh-client-connection`](../../client/connection/README.zh.md)）；各 Client 功能仍可以在非 loopback 页面上拒绝原生操作或持久化操作。

### 网关暴露什么

一元映射只包含 `host.describe`；直接下载路由是 `GET` 或 `HEAD /api/session.export`。Session、workspace、settings、credentials、LLM、skill、file-reference、command 与 interaction 操作都是由各业务包持有、并由 [`dsh-api-remotes`](../../api/remotes/README.zh.md) 组装的生成 Remote。

### 导出会话

`GET /api/session.export?sessionId=…&includeDescendants=true` 流式输出一个 ZIP，其中每个会话的已存工件文本原样包含，每个子代理后代位于 `subagents/<id>/` 下，每张被引用的图片位于 `media/<attachmentId>.<ext>` 下。`HEAD` 在无请求体的情况下运行同样的根准备，因此浏览器能在把 GET 交给下载管理器之前检测到流前失败。响应边生成边分块输出，`sessionExportCompressionLevel`（0–9，默认 6）在 CPU 与延迟之间权衡归档大小。缺少 persistence、session-query 或 attachment 服务时回答 500，后端没有按会话原始工件时回答 501，根会话缺失时回答 404。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `nativeOpen` | 平台探测 | 部署能否把路径交给原生桌面打开器 |
| `sessionExportCompressionLevel` | `6` | 每个会话日志 ZIP 条目的 DEFLATE 级别，0–9 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-host-apiproxy)是每个受支持字段及其 JSDoc 的穷尽式真源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计理念

本包建立在一个分离之上：API 约定与通道无关，物理传输只是围绕它的载体。协议消息构成一个二元可辨识联合——`ClientRequest`（POST `/api/<method>` 的请求体）与 `ServerResponse`（该 POST 的响应体）——与物理通道解耦。响应始终回显对应请求的 `rpcId`，绝不签发新值。业务错误由 `RpcResult` 的错误分支承载，其 `RpcErrorDetailsMap` 封闭错误码集合；HTTP 状态只表达载体层结果。分层与协议决策记录在 [GUI 分层与 RPC 协议 RFC](../../../.agents/notes/implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.zh.md) 中。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/api/`](src/api/) | 约定层：领域接口、payload 类型、zod schema、`RpcMethodMap`——零 Node 依赖 |
| [`src/fetch/handler.ts`](src/fetch/handler.ts) | 宿主载体：`toFetchHandler`、信封解析、一元分发、会话导出 |
| [`src/fetch/client.ts`](src/fetch/client.ts) | 客户端载体：`AbstractApiClient` 及平台子类、`InProcessApiClient` |
| [`src/api-proxy.ts`](src/api-proxy.ts) | 网关实现：基于所组合宿主上下文的 `createApiProxy` |
| [`src/session-export.ts`](src/session-export.ts) | 会话日志 ZIP 导出：原始工件读取、媒体收集、fflate 流式输出 |

### 网关服务

`ApiProxyService` 提供 `ctx.apiProxy`，通过 `host.describe` 报告进程元数据，并把 Session 归档生成委派给 persistence、query、attachment 与 live Session 服务。Host cwd 是默认项目目录。产品的 `dsh --profile headless` 是直连 core 的入口，不挂载本包。

### 请求流

`host.describe` 请求进入 fetch 载体，载体解析 envelope 与 payload、分发方法，并返回回显请求 `rpcId` 的响应。Session 导出不使用该 envelope，因为其流式 ZIP body 与 HTTP 状态就是结果。

### 网关拥有什么

本包持有旧版 envelope、Host 启动快照与归档下载。API Gateway 持有生成的 Remote 分发与流；业务包持有各自的方法和结果类型。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下内容。它们从分层决策进入浏览器侧消费架构与相邻子系统。

- [GUI 分层与 RPC 协议 RFC](../../../.agents/notes/implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.zh.md)——分层模型与通道无关的消息协议。
- [Web 客户端架构 RFC](../../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.zh.md)——浏览器如何消费该 API。
- [浏览器 HTTP 载体](../../client/connection/README.zh.md)——Host/Origin 检查、签名 cookie 认证，以及随发行版交付的 Web 组合注册的路由。
- [Web 服务器子系统](../../../docs/subsystems/web-server.zh.md)——载体所搭乘的 HTTP 服务器。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-host-apiproxy)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

无。该协议约定与 fetch 载体只搬运已组装好的消息，不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明网关在何处不合适；它们是当前包约束，不是任务积压。

- **没有协议版本字段**——客户端与宿主一同发布；只有出现独立发布的客户端后，`host.describe` 才会增加版本协商字段。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放方向。它明确不具权威性——已交付行为与限制见上文各节。协议版本字段等待独立发布的客户端；多用户载体必须把提供方搜索诊断替换为可安全公开的文本；按连接的自适应目录选择（本地浏览器用 native、远程浏览器用 browse）仍是宿主表面的一个未定方向。

</details>
