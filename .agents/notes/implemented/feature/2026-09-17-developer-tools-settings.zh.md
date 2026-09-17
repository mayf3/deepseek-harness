# Agent Note: 共享开发者工具设置

Status: implemented

[English](2026-09-17-developer-tools-settings.md) | 中文

## Problem

诊断视图、预设选择和改动文件摘要增加了日常任务的复杂度。支持脚本的 HTML 还授予了基础文档预览不需要的能力。桌面端和 Web 共享这些渲染器，分别设置开关会让同一设置在不同客户端产生不同结果。

## Decision

设置所有者提供一个已接受的 `ui-developer-tools.enabled` 偏好，默认关闭。Web 和桌面端的通用设置提供同一个开关。现有设置传输负责验证、有序写入、持久化和恢复；浏览器不再复制偏好状态。回环 Web 和桌面端使用 Host 持久化，远程 Web 保持现有的内存策略。

关闭时仅展示 Chat，移除会话 View 标签栏，隐藏新会话预设入口，并省略改动文件卡片及其摘要读取。在其他 View 中关闭开关会激活 Chat。预设组合、保存的默认值、Session 事件和显式交付卡片保持不变。此偏好是展示策略，不是 Host 授权。

内置 HTML 渲染器执行自己的预览策略。关闭时，内容被解析到惰性 template 中，移除主动文档与导航，再放入不授予沙箱权限的 iframe，并通过 CSP 禁止脚本和外部资源。不读取关联文件。开启时保留不透明源的脚本 Blob 渲染器及其有界关联文件读取。切换模式会替换浏览上下文并清理待处理读取。[文档预览决策](../architecture/2026-09-08-document-preview-operations.zh.md)和[文件系统读取权限](../architecture/2026-09-09-workspace-file-read-authority.zh.md)继续定义高级渲染与 Host 读取访问。

## Alternatives considered

**仅在桌面端提供开关。** 所选需求没有仅限桌面的约束，相关 UI 也是共享的。桌面端条件判断会让 Web 渲染器的展示和预览行为不一致。

**隐藏控件但不改变激活的 View 或 iframe。** 之前选择的诊断内容和已经运行的脚本会在切换后继续存在。过滤可用 View 并重新挂载 HTML 上下文，可以立即执行所选展示策略。

## Consequences

基础 HTML 放弃 JavaScript、外部与关联资源和链接导航；行内样式与 data 图片仍可用。高级模式保留正常浏览器网络能力，不增加父源、弹窗、表单或顶层导航权限。此设置不约束第三方预览实现，也不撤销 Host 文件系统读取权限。

组件和设置测试覆盖默认值、schema 拒绝、已接受状态更新、入口折叠、改动文件展示和 iframe 清理。基于已记录 Session 的[文档预览](../../../../apps/web/tests/document-preview.e2e.ts)与[改动文件](../../../../apps/web/tests/changed-files-turn.e2e.ts)场景验证真实设置控件及共用渲染器。浏览器脚手架为诊断场景显式开启开发者模式；这两个场景保留产品默认值。原生 Electron 执行是独立的验收面。
