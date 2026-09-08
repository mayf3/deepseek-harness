---
description: "通过 present 工具交付工作区文件的不可变快照；配置、Session 归属与下载前提。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-present

[English](README.md) | 中文

## 概述

使用 `present` 交付最终工作区文件，包括通过 shell 命令创建的文件。每次成功调用都会保存不可变字节，因此源文件被编辑或删除后，用户仍可下载交付时的版本。交付归调用方 Session 所有；Web 交付插件提供下载链接和卡片。

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

`standard`、`ptc` 与 `cordis` Agent preset 挂载本插件。创建文件后，以 `files: [{ path, description? }]` 调用 `present`。文件必须存在于 Session 工作区内，且为普通文件。文件缺失、超限、位于工作区外或读取期间发生变化时，调用失败。

在 Agent 的 Cordis 组合中挂载，并提供 `tools`、`fs`、`attachments` 和 `turnBoundary` Session 投影：

```yaml
- name: '@deepseek-ai/dsh-tool-present'
  config:
    maxFileBytes: 104857600
    maxFiles: 8
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxFileBytes` | `104857600` | 每个文件的字节上限，为正整数且不超过 100 MiB |
| `maxFiles` | `8` | 每次调用的最大文件数，为正整数 |

挂载时校验限制。工具要求 Agent Session 具有工作区和已开始的 turn。交付归调用方 Session 所有；父 Session 如需为子 Agent 创建的文件提供自己的下载链接，必须自行调用 `present`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

工具通过配置的文件系统提供方解析路径，检查工作区包含关系和有界读取前后的版本，并通过 attachment 服务保存字节。成功的最终 `tools/result` 通知追加 `deliverables/presented`，嵌套调用也适用。外层程序随后失败不会撤销已完成的交付。被阻止的结果不发布交付。每个插件实例只记录其实际执行调用保存的快照；同名作用域工具不能通过其他实例发布交付。

纯 `./types` 入口声明 `PresentedFile` 与 Session 事件，不导入 Host 运行时代码。Web 消费方在展示或授权下载前校验持久引用。事件不保存 Session ID，因此 fork 历史通过当前查看的 Session 授权下载。

**运行时不变式：** 不发布伴生入口。工具与事件注册归 effect 所有；attachment 服务拥有不可变字节，Session 日志拥有交付引用。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [文件系统子系统](../../../docs/subsystems/filesystem.zh.md)——提供方路径与错误。
- [Attachment 服务](../../attachment/attachment/README.zh.md)——保存的字节与保留策略。
- [Web 交付](../../client/ui-deliverables/README.zh.md)——认证下载与卡片。
- [交付决策](../../../.agents/notes/implemented/feature/2026-09-08-web-explicit-file-delivery.zh.md)——Session 归属与读取端必须识别的事件。

<a id="model-experience"></a>
## 模型体验

### present

#### 模型看到的内容

[present schema](../../../docs/tool-catalog.zh.md#present)要求已有的工作区文件：“Deliver final files to the user. Saves a snapshot of each existing workspace file so it remains downloadable after edits or deletion. Create the files before calling this tool.” 每个文件的结果为 `Presented <path> (<bytes> bytes)`；attachment ID 保留在程序结果和持久事件中。

#### Token 影响

每个挂载的 Agent 增加一个工具 schema，每个交付文件增加一行结果。文件字节不进入模型消息。

#### KV Cache 影响

工具 schema 在挂载期间保持静态。交付结果文本扩展对话，不重写提示词前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 路径包含关系和读取前后版本校验会拒绝普通变化，但路径 API 无法原子防御恶意替换后复原。
- 失败调用此前保存的文件可能作为无引用对象留在 attachment 存储中。
- Session ZIP 导出在 JSONL 中保留交付引用，不包含交付字节。转移后下载依赖服务主机 attachment 存储中的同一快照。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
