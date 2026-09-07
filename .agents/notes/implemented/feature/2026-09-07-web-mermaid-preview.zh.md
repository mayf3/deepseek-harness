# Agent Note: Chat 代码 fence 中的 Mermaid 预览

Status: implemented

[English](2026-09-07-web-mermaid-preview.md) | 中文

## 问题

Assistant 回复可以在 Mermaid 代码 fence 中描述图表，但读者必须理解源码或把它复制到其他渲染器。渲染需要处理不完整的流式输入与不可信图表内容，同时保持在 Chat 之外的可复用性。

## 决策

Chat 通过 `MarkdownLabels.mermaid` 启用已定稿 fence 预览。共享 Markdown 渲染器使用解析后的 fence 语言；流式 fence 和未传入这些 label 的调用方保留代码显示。静态 [UI primitives 包](../../../../packages/client/ui-primitives/README.zh.md)拥有 `MermaidPreview`，它接收源码与本地化 label，不依赖 Session、文件或 Cordis。`CodeBlock.preview` 复用标题栏和复制操作；复制始终读取源码 prop。

Mermaid 按需加载。它的公开 render API 串行执行图表工作，每次调用在 `finally` 中移除临时测量 DOM。图表配置无法覆盖严格安全模式、禁用 HTML label、中性主题和错误渲染策略。生成的 SVG 以图片显示，不安装图内链接或脚本。固有尺寸取自 SVG viewBox；大图缩小以适应宽度，画布在两种应用主题下均保持浅色。

替换源码与卸载组件会取消结果发布。在运行时加载完成前取消可阻止渲染；已经开始的 Mermaid 渲染会完成并释放 DOM，但无法向已取消的组件发布结果。失败时显示本地化错误和原始源码。用有效图表替换非法源码可恢复预览。

## 考虑过的替代方案

**渲染每个流式分片。** 不完整的图表经常无效，反复布局也会与文本流式输出竞争。已有的消息定稿边界提供完整源码值。

**把渲染放在 Chat 内或增加通用预览注册表。** 接收普通 prop 的共享原语无需另一套注册表或功能插件依赖即可满足复用。这遵循[共享控件规则](../architecture/2026-09-05-shared-client-control-primitives.zh.md)。

**把可交互 SVG 插入消息。** 此次预览需求只需要图表显示与源码访问。将结果显示为图片后，图内链接和事件处理器不会生效。

## 后果

功能只改变展示，不改变持久化消息、提供者请求、工具或 Host API。Mermaid 增加按需加载的浏览器资源。渲染仍在浏览器线程上执行，已交给库的工作无法中断。首版不包含编辑、导出、缩放控件或可交互图内链接。

组件测试覆盖延迟完成、过期成功与失败、卸载、源码回退和复制。无密钥[浏览器场景](../../../../apps/web/tests/markdown-mermaid.e2e.ts)通过完整 Chat 组合验证中文流程图、时序图、非法源码、配置覆盖以及英文／中文 UI 快照。
