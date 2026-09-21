---
description: "配置显式产品使用事件、OTLP/HTTP 路由、批量发送与退出等待上限。"
kind: "package-reference"
---

# @deepseek-ai/dsh-product-telemetry-otel

[English](README.md) | 中文

## 概述

将选定的产品使用事件发送到 OTLP/HTTP 接收服务。事件包含名称、字符串摘要、发生时间，以及标量或单层对象属性。挂载插件不会自动采集信息；应用需要显式提交每个事件。发送采用尽力而为方式，不代表数据已入仓。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 Cordis 组合中挂载插件并提供应用标识；需要时可覆盖接收地址。内置 profile 不挂载本插件。

```yaml
- name: '@deepseek-ai/dsh-product-telemetry-otel'
  config:
    endpoint: https://dsh-otel-collector.deepseeksvc.com/v1/logs
    serviceName: dsh-telemetry-test
    serviceVersion: test
    compression: gzip
    scheduledDelayMillis: 30000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `endpoint` | `https://dsh-otel-collector.deepseeksvc.com/v1/logs` | 完整 HTTP(S) 日志地址 |
| `serviceName`, `serviceVersion` | 必填 | OTel resource 中的应用标识 |
| `channel` | `dsh_otel_report` | 接收服务的 `x-channel` 请求头 |
| `compression` | SDK 环境变量 | `gzip` 或 `none`；省略时遵循 OTel 压缩环境变量 |
| `maxExportBatchSize`, `maxQueueSize` | `512`, `2048` | 记录条数上限；批次大小不能超过队列大小 |
| `scheduledDelayMillis` | `30000` | 不满批次时的发送间隔 |
| `timeoutMillis` | `15000` | Exporter HTTP 发送与重试的超时时间 |
| `exportTimeoutMillis` | `20000` | Processor 批次导出的超时时间 |
| `shutdownTimeoutMillis` | `21000` | 退出时的等待上限；超时会提示可能丢失数据 |

消费方注入 `productTelemetry`，调用 `emit()` 提交明确选定的分析字段。事件名称与字段含义由产品和数据分析负责人定义。插件不读取 Session、账号、凭证或设备标识。调用方必须排除提示词、回答、文件内容、凭证及其他未经批准的数据。

接收服务要求 body 为字符串，attributes 的值为字符串、数字、布尔值或由这些标量组成的对象。调用方以毫秒提供发生时间；插件填写观测时间，默认严重程度为 INFO。无效传输配置在激活时报错。发送失败产生本地警告，事件提交不等待网络。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

私有 OTel logger 将记录交给 `BatchLogRecordProcessor` 和 HTTP JSON exporter。SDK 负责队列、临时错误重试与压缩；插件卸载时在限定时间内发送剩余记录。发送完成结果单独观测，因为 SDK 在发送被拒绝后仍可能正常完成退出。不安装全局 OTel provider。

[`src/index.ts`](src/index.ts) 负责配置与提交。不发布运行时不变量伴随模块：本地没有独立的送达确认可与 SDK 队列比较。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [产品埋点](../../../docs/subsystems/product-telemetry.zh.md)——消费方类型与服务参考。
- [会话上报](../../session/session-telemetry-otel/README.zh.md)——独立的、由反馈授权的 Session 上报。
- [测试策略](../../../docs/testing.zh.md)——Loader 组合与网络测试夹具。

-----

<a id="model-experience"></a>
## 模型体验

无，因为插件仅发送显式分析记录，不提供模型上下文。

#### KV Cache 影响

无；提交事件不会改变模型请求。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

发送和采集受以下能力限制。

- 不自动接入业务事件、渲染进程传输或账号与设备标识。
- 队列仅存在于内存；队列溢出、网络故障和进程退出可能丢失事件。没有持久发件箱或入仓确认。
- SDK 按记录条数而非编码字节数分批。调用方必须确保记录不超过接收服务的 4 MB 限制，并选择接收服务适用的批次大小。
- 不自动脱敏调用方选择的字符串。本包不决定产品告知或同意策略。

<a id="dev-note"></a>
### 开发备注

无。
