# Agent Note: 静态 Markdown fence 预览

Status: implemented

[English](2026-09-09-markdown-static-previews.md) | 中文

## Problem

读者需要直接在 Assistant 回复中查看 Mermaid 和 DOT 图表、SVG 图像和 HTML 示例，而不必解读源码或复制到其他渲染器。这些源码不可信，而渲染器的 npm 许可证字段可能遗漏编译组件各自的分发义务。

## Decision

共享 Markdown 渲染器通过本地化的 `MarkdownLabels.preview` 和解析后的 fence 语言启用定稿后的 `mermaid`、`graphviz`/`dot`、`svg` 和 `html` fence。[UI primitives 包](../../../../packages/client/ui-primitives/README.zh.md)拥有 `SourcePreview`，它接收渲染器、源码和文案，不依赖 Session、文件或 Cordis。Mermaid 与 Graphviz 各自向同一组件提供 `.ts` 渲染器。未提供预览文案的调用方与流式消息保留代码显示。

`CodeBlock.preview` 负责默认可视化、源码切换与原样复制。预览省略语言横幅，在悬停或键盘聚焦时显示紧凑的图标操作；具有任何触控输入的设备始终在图表下方显示操作。切换到源码会隐藏已挂载的预览，保留完成的渲染和待完成的工作。两种视图使用同一个保持焦点的切换按钮，复制始终读取源码属性。

`SourcePreview` 负责加载、失败和取消过期结果发布。替换源码和卸载组件会取消结果发布；在运行时加载完成前取消会跳过布局。失败时显示本地化错误与原始源码，用有效输入替换无效源码后可以恢复预览。

Mermaid 按需加载。其公开渲染 API 串行执行图表工作，每次调用都在 `finally` 中删除临时测量 DOM。图表配置无法覆盖严格安全模式、禁用 HTML 标签、中性色主题和错误渲染策略。生成的 SVG 作为图片显示，不安装链接或脚本。固有尺寸来自 SVG viewBox；大图缩小以适应宽度，两种应用主题下的画布均保持浅色。

HTML 先由 DOMPurify 清理，禁止导航属性与文档加载元素，再进入不透明来源的 `sandbox=""` iframe。可信 CSP 位于源码标记之前，仅允许内联 CSS、data 图片与 data 字体。脚本、外部资源、子 iframe、表单提交与同源访问均不可用。SVG 按 XML 解析后作为图片放进 iframe，因此 SVG 脚本与链接不会激活。iframe 使用固定的可滚动视口：测量内容需要额外的来源访问权限或可信 iframe 脚本。

Graphviz 使用固定且未修改的 `@viz-js/viz` 3.30.0 WebAssembly 发布包，布局引擎为 `dot`。其 npm MIT 声明覆盖包装层；构建来源记录标明 Graphviz 16.0.0（EPL-2.0）、Expat 2.8.4（MIT）与 Emscripten 5.0.7（MIT/NCSA）。分发保留各组件条款，并按 EPL-2.0 第 3.1 节提供准确的 Graphviz 源码下载地址。[完整预览声明](../../../../packages/client/ui-primitives/THIRD_PARTY_PREVIEW_NOTICES.txt)还保留 Mermaid 的 MIT 文本，并为 DOMPurify 选择 Apache-2.0。UI primitives 包携带该声明，Web 构建在资源旁输出相同字节。内嵌产物的许可证检查独立于通用的宽松 npm 元数据策略。

## Alternatives considered

**在图表上方保留代码横幅。** 语言标签和常驻文字控件会分散对图表的注意力。浮层操作保留源码访问，不占用标题行。

**渲染每个流式片段。** 未完成的图表通常无效，反复布局会与文本流式输出争用资源。消息定稿可提供完整源码。

**在 Chat 内部渲染，或添加通用预览注册表。** 使用普通属性的共享基础组件即可满足复用，无需另加注册表或功能插件依赖。这遵循[共享控件规则](../architecture/2026-09-05-shared-client-control-primitives.zh.md)。

**在 iframe 内执行 HTML 脚本。** 静态聊天示例不需要脚本执行。空 sandbox、清理与 CSP 降低预览权限，也避免引入 iframe 消息协议。

**把渲染标记插入 Chat。** 所需预览只需显示图表和访问源码；HTML 样式和可执行 SVG 会与应用共享文档。iframe 隔离布局与来源，SVG 图片模式额外禁用 SVG 行为。

**将 Viz.js 视为仅使用 MIT，或使用远程 Graphviz 服务。** 本地编译的 Graphviz 仍受其许可证约束；远程渲染会把对话内容发送到设备之外。内置渲染器保留源码可获取性与法律声明，无需网络渲染。

## Consequences

该功能改变呈现，不改变持久化消息、provider 请求、工具或 Host API。HTML 内联样式可用，交互脚本、外部资源和链接不可用。Mermaid 和 Graphviz 增加按需加载的浏览器资源，并在浏览器线程上执行布局。取消无法抢占进行中的布局；即使结果无法发布，Mermaid 仍会完成并释放测量 DOM。预览不提供编辑、导出、缩放控件或交互式图表链接。

组件测试覆盖源码复制、默认预览、延迟完成、过期成功与失败、卸载、回退、取消、运行时加载失败与恢复。无密钥[浏览器场景](../../../../apps/web/tests/markdown-mermaid.e2e.ts)验证中文 Mermaid 流程图、时序图、无效源码、配置覆盖、不透明来源 iframe、真实图片解码、源码切换、脚本／导航／资源请求被阻止、中英文 UI 快照和已提供的许可证文本。声明检查固定已审查的包装层与原生构建来源，升级时须重新审查。
