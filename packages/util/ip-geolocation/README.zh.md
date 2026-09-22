---
description: "查询调用进程网络出口对应的国家，限制 HTTP 响应大小，并由调用方控制取消。"
kind: "package-library"
---

# @deepseek-ai/dsh-ip-geolocation

[English](README.md) | 中文

## 概述

查询调用进程公网出口对应的国家。`lookupIpCountry` 接受返回 JSON 国家字段的接口地址、中止信号和响应字节上限。消费方自行决定接口、超时、缓存和业务规则；库不保留 IP 地址或查询结果。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在需要判断网络出口的进程中调用 `lookupIpCountry`。[插件安装对话框](../../client/ui-plugin-manager/README.zh.md) 在下载插件的 pnpm 所在 Host（宿主）进程中调用它。本库不注册 Cordis 服务或事件。

提供实现 [GeoJS 国家响应](https://www.geojs.io/docs/v1/endpoints/country/) 或兼容调用方 IP 查询协议的 HTTP(S) 接口、覆盖完整操作的取消信号，以及正数响应字节上限。`country` 字段为大写双字母代码时返回该代码；JSON null 或 HTTP 404 返回 null。其他 HTTP 错误、无效数据、取消和超限响应均拒绝。其余字段（包括返回的 IP）被丢弃。

请求使用普通 `fetch`，遵循 Host 配置的[出站代理](../http-proxy/README.zh.md)。重定向被拒绝。超时和失败策略由消费方负责；库不会根据语言或时区推断国家。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[`src/index.ts`](src/index.ts) 在解析 JSON 前限制完整流式响应体的大小，校验国家字段，并在完成或失败后释放读取器。本库不保留可独立偏离的状态，因此不发布运行时不变量伴随模块；传输和解析测试直接观察每次调用。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [共享工具库](../README.zh.md) — 相邻的库。
- [插件安装](../../client/ui-plugin-manager/README.zh.md) — 消费方对话框的安装源选择策略。

-----

<a id="model-experience"></a>
## 模型体验

无。本库不注册工具、提示词段落或 Session（会话）事件。

#### KV Cache 影响

无。国家查询结果不进入模型请求。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

- IP 地理定位估计的是网络出口，使用代理或 VPN 时可能与用户所在地不同。
- 接口必须返回双字母 `country` 字段。本库不查询任意指定 IP，也不查询城市级信息。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
