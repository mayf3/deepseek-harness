---
description: "宿主转换提供方使用的已授权 Office 输入与完整 PDF 输出。"
kind: "package-reference"
---

# @deepseek-ai/dsh-document-convert

[English](README.md) | 中文

## 概述

将已授权的 `.doc`、`.docx`、`.xls`、`.xlsx`、`.ppt` 和 `.pptx` 字节转换为完整 PDF。调用方获得 PDF 字节；OOXML 输入还提供缺失字体名称，不修改原文件或添加模型上下文。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

挂载 [LibreOffice 提供方](../document-convert-libreoffice/README.zh.md)以提供 `ctx.documentConvert`。抽象服务没有可挂载实现或配置。调用方须先授权并 stat 源文件，再向 `convert()` 传入标识、版本、可选字节数、延迟的有界读取、Office 扩展名和调度优先级。提供方在调用读取回调前准入元数据。源版本变化时拒绝转换。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

提供方返回各调用方独立拥有的 PDF 字节、转换缓存键和转换 generation。消费者在复用缓存 PDF 前检查 `generation`；替换配置会创建新的 generation。单个读取方取消时立即拒绝；提供方销毁会等待实际读取、转换和临时文件清理。取消以其原因拒绝；已分类的转换失败使用 `DocumentConvertError`。提供方和消费者通过 peer dependency 共享此包，使 `instanceof DocumentConvertError` 能识别双方的失败。此服务仅声明操作，没有独立保留的观测，因此不发布运行时不变量伴随入口。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [文档转换](../../../docs/subsystems/document-convert.zh.md) — 组合和所有权。
- [工作区文件](../../api/workspace-files/README.zh.md) — Session 文件授权与有界读取。

-----

<a id="model-experience"></a>
## 模型体验

无，因为此包仅转换字节，不提供面向模型的工具、消息或 Session 事件。

#### KV Cache effect

无；转换不会构造或修改模型请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 服务仅接受上述六种 Office 格式；源文件授权由消费者负责，共享转换复用由提供方负责。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
