---
description: "经 Session 授权的 Office 转换，为 Client 预览返回 PDF 字节。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-document-render-controller

[English](README.md) | 中文

## 概述

从 Session 打开 Office 文件并取得渲染后的 PDF。源文件访问遵循常规工作区文件策略，转换不会激活 Agent 或追加 Session 事件。

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

[Web bundle](../../bundle/web-app/README.zh.md)在 `workspaceFiles` 和 `documentRender` 旁以 `document-render-controller` 条目挂载此控制器。控制器没有配置。其 `documentRender.render` Remote 接受 Session 标识、DOC、DOCX、XLS、XLSX、PPT 或 PPTX 路径以及 `foreground` 或 `background` 优先级；共享 Session 查找在 Host 推导工作区根目录。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

控制器先通过单字节 `workspaceFiles.readBytes` 调用检查普通读取权限，再通过 `workspaceFiles.stat` 确认源版本，然后向渲染器提供延迟的 `workspaceFiles.readAllBounded` 回调。准入先于源分配；回调在读取后检查元数据，拒绝并发源变更。有界读取因大小限制失败时也会复查源身份，若当前源身份不同则报告 `source-changed`。缓存响应同样重复读取权限和元数据检查。结果包含 base64 PDF 字节、原始绝对路径与版本以及渲染 generation。`generation()` Remote 供 Client 在替换渲染器后使 PDF 失效。其他源读取失败直接传递；转换失败仅暴露分类原因，不含引擎诊断。取消会释放当前读取方的使用权；实际工作结束前，渲染器保留活动容量。控制器卸载会等待其未完成请求。结果为临时数据，没有独立持久状态，因此不发布运行时不变量伴随入口。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [工作区文件](../workspace-files/README.zh.md) — 读取策略和 Session 查找。
- [渲染服务](../../document/office-to-pdf/README.zh.md) — 转换输入和结果。
- [Office 查看器](../../client/ui-sidebar-documentpreview/README.zh.md#office-preview) — Client 二进制缓存。

-----

<a id="model-experience"></a>
## 模型体验

无，因为此包仅服务预览，不提供模型工具、消息或 Session 事件。

#### KV Cache effect

无；预览操作不构造或修改模型请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 完整源读取也遵循 `workspaceFiles.maxFileBytes`；仅提高渲染器输入上限不会增加读取额度。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
