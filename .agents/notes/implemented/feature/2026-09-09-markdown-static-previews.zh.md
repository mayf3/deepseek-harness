# Agent Note: 静态 Markdown fence 预览

Status: implemented

[English](2026-09-09-markdown-static-previews.md) | 中文

## Problem

读者需要直接在 Assistant 回复中查看 DOT 图表、SVG 图像和 HTML 示例。这些源码不可信，而渲染器的 npm 许可证字段可能遗漏编译组件各自的分发义务。

## Decision

共享 Markdown 渲染器通过本地化的 `MarkdownLabels.preview` 启用定稿后的 `graphviz`/`dot`、`svg` 和 `html` fence。`CodeBlock.preview` 负责默认可视化、源码切换与原样复制。`SourcePreview` 为这些文档及 [Mermaid 预览](2026-09-07-web-mermaid-preview.zh.md)负责加载、失败和取消过期结果发布。未提供预览文案的调用方与流式消息保留代码显示。

HTML 先由 DOMPurify 清理，禁止导航属性与文档加载元素，再进入不透明来源的 `sandbox=""` iframe。可信 CSP 位于源码标记之前，仅允许内联 CSS、data 图片与 data 字体。脚本、外部资源、子 iframe、表单提交与同源访问均不可用。SVG 按 XML 解析后作为图片放进 iframe，因此 SVG 脚本与链接不会激活。iframe 使用固定的可滚动视口：测量内容需要额外的来源访问权限或可信 iframe 脚本。Mermaid 保留既有的严格渲染器与不可执行图片展示。

Graphviz 使用固定且未修改的 `@viz-js/viz` 3.30.0 WebAssembly 发布包，布局引擎为 `dot`。其 npm MIT 声明覆盖包装层；构建来源记录标明 Graphviz 16.0.0（EPL-2.0）、Expat 2.8.4（MIT）与 Emscripten 5.0.7（MIT/NCSA）。分发保留各组件条款，并按 EPL-2.0 第 3.1 节提供准确的 Graphviz 源码下载地址。[完整预览声明](../../../../packages/client/ui-primitives/THIRD_PARTY_PREVIEW_NOTICES.txt)还保留 Mermaid 的 MIT 文本，并为 DOMPurify 选择 Apache-2.0。UI primitives 包携带该声明，Web 构建在资源旁输出相同字节。内嵌产物的许可证检查独立于通用的宽松 npm 元数据策略。

## Alternatives considered

**在 iframe 内执行 HTML 脚本。** 静态聊天示例不需要脚本执行。空 sandbox、清理与 CSP 降低预览权限，也避免引入 iframe 消息协议。

**把渲染标记插入 Chat。** HTML 样式和可执行 SVG 会与应用共享文档。iframe 隔离布局与来源，SVG 图片模式额外禁用 SVG 行为。

**将 Viz.js 视为仅使用 MIT，或使用远程 Graphviz 服务。** 本地编译的 Graphviz 仍受其许可证约束；远程渲染会把对话内容发送到设备之外。内置渲染器保留源码可获取性与法律声明，无需网络渲染。

## Consequences

不改变 Session 事件、提示词或工具。HTML 内联样式可用，交互脚本、外部资源和链接不可用。Graphviz 增加按需加载的 WebAssembly 资源与浏览器线程同步布局；源码取消可以阻止结果发布，但无法抢占进行中的布局。Mermaid 既有布局限制仍记录在其所属决策中。

组件测试覆盖源码复制、默认预览、回退、取消与恢复。无密钥[浏览器场景](../../../../apps/web/tests/markdown-mermaid.e2e.ts)验证不透明来源 iframe、真实图片解码、源码切换、脚本／导航／资源请求被阻止、本地化快照和已提供的许可证文本。声明检查固定已审查的包装层与原生构建来源，升级时须重新审查。
