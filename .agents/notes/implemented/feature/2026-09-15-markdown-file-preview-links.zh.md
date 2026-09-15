# Agent Note: Markdown 文件预览链接

Status: implemented

[English](2026-09-15-markdown-file-preview-links.md) | 中文

## Problem

Assistant 讲解会链接到本轮未修改或交付的现有源码文件。若仅允许产出文件提及成为可点击引用，读者就无法在回答旁打开这些源码。

## Decision

落定后的 Assistant Markdown 将显式本地链接目标传给 Chat 文件打开器。渲染器识别绝对路径和工作区相对路径，对百分号转义解码一次，并将 `#L24` 或 `#L24-L30` 分离为起始行导航请求。文件控件保留原始标签并显示文件类别图标，绝不让浏览器导航到原始路径。

现有[侧栏导航](../architecture/2026-09-05-sidebar-tab-types-and-navigation.zh.md)负责 Session 寻址、标签复用及预览选择。Host 文件服务保留访问检查和文件缺失错误。行内代码的产出文件匹配保持独立。外部 URL 保留协议允许列表；查询串、仅有片段的目标、不支持的片段、错误转义及无效行号范围均不可点击。

## Alternatives considered

- 允许相对浏览器链接：这会跳转应用 URL，而非请求 Session 文件内容。
- 要求产出文件条目：这会排除普通只读讲解。
- 增加预览服务：Chat 已提供所需打开器和行号参数。

## Consequences

源码引用无需新增 Session 事件或模型提示词。链接在消息落定后可用。范围定位到起始行；预览不会高亮多行选区。单元测试覆盖目标解析和回调连接；无密钥的 `markdown-file-links` Web 快照通过正式组合覆盖文件内容、行号导航和标签复用。
