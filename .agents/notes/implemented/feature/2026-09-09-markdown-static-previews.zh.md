# Agent Note: 静态 Markdown fence 预览

Status: implemented

[English](2026-09-09-markdown-static-previews.md) | 中文

## Problem

读者需要在保留代码为主要表示的同时，按需直接查看 Assistant 回复中的 Mermaid 与 DOT 图表和 SVG 图像。这些源码不可信，而渲染器的 npm 许可证字段可能遗漏编译组件各自的分发义务。

## Decision

共享 Markdown 渲染器通过本地化的 `MarkdownLabels.preview` 和解析后的 fence 语言启用定稿后的 `mermaid`、`graphviz`/`dot` 和 `svg` fence。[UI primitives 包](../../../../packages/client/ui-primitives/README.zh.md)拥有 `SourcePreview`，它接收渲染器、源码和文案，不依赖 Session、文件或 Cordis。Mermaid 与 Graphviz 各自向同一组件提供 `.ts` renderer。HTML、未提供预览文案的调用方与流式消息保留代码显示。

`CodeBlock.preview` 是标准化的源码预览描述，包含 renderer 以及完整的本地化输出与控件文案；调用方不传入 React 节点。`MarkdownText` 按预览文案对象的 identity 创建一份描述目录，之后正文、文件提及或本地图片词表变化引起的每次定稿渲染都复用其中的语言条目。[CodeBlock 交互决策](2026-09-10-codeblock-preview-interaction.zh.md)取代本文的默认源码和切换时释放结果的选择，负责当前控件与结果保留。[预览尺寸决策](../simplification/2026-09-14-source-sized-code-block-previews.zh.md)负责当前几何行为。本文保留独立的渲染、安全与分发决策。

`SourcePreview` 负责待完成工作、失败和取消过期结果发布。待完成的预览显示本地化状态。替换源码和卸载组件会取消结果发布；在运行时加载完成前取消会跳过布局。失败时显示本地化错误与原始源码，用有效输入替换无效源码后可以恢复预览。

Mermaid 按需加载。共享队列将主题初始化与图表渲染一起串行执行，每次调用都在 `finally` 中删除临时测量 DOM。图表配置无法覆盖严格安全模式、禁用 HTML 标签、应用配色和错误渲染策略。布局前检查解析后的 flowchart 节点并拒绝图片节点；Mermaid 的严格模式仍会在图片节点布局时请求外部资源，最终 SVG 图片隔离无法阻止这一请求。生成的 SVG 作为图片显示，不安装链接或脚本。固有尺寸来自 SVG viewBox；大图缩小以适应宽度，画布使用代码块背景。已挂载的预览观察文档主题属性，仅在解析后的配色变化时重新生成；过期渲染不能发布结果。Graphviz 的默认颜色采用同一配色，DOT 与 SVG 中明确指定的颜色保持原样。

SVG 按 XML 解析后，与 Graphviz 输出一同作为不可执行图片显示，因此 SVG 脚本、链接与外部资源不会激活。放大镜会打开 body portal 对话框；其视口适应、平移和缩放行为由 [CodeBlock 交互决策](2026-09-10-codeblock-preview-interaction.zh.md)负责。

Graphviz 使用固定且未修改的 `@viz-js/viz` 3.30.0 WebAssembly 发布包，布局引擎为 `dot`。其 npm MIT 声明覆盖包装层；构建证明标明 Graphviz 16.0.0（EPL-2.0）、Expat 2.8.4（MIT）与 Emscripten 5.0.7（MIT/NCSA）。分发保留各组件条款，并按 EPL-2.0 第 3.1 节提供准确的 Graphviz 源码下载地址。[完整预览声明](../../../../packages/client/ui-primitives/THIRD_PARTY_PREVIEW_NOTICES.txt)还保留 Mermaid 的 MIT 文本和其 DOMPurify 依赖选用的 Apache-2.0 条款。UI primitives 包携带该声明，Web 构建在资源旁输出相同字节。内嵌产物的许可证检查独立于通用的宽松 npm 元数据策略。

源码高亮在流式与定稿图表 fence 中共用按需加载的 Shiki 高亮器。SVG 解析为 XML；Mermaid 选用上游语法的 `#mermaid` 正文规则，因为 CodeBlock 已去除 Markdown 围栏。DOT 使用[第三方声明](../../../../packages/client/ui-primitives/THIRD_PARTY_PREVIEW_NOTICES.txt)中固定的 MIT TextMate 语法，机械转换保留所有模式与 scope。这让源码着色独立于预览渲染，也避免维护单独的 DOT tokenizer。

## Alternatives considered

**默认显示可视化并使用浮层图标操作。** 默认源码的决策优先展示作者代码，并避免显式请求前执行图表工作。[交互决策](2026-09-10-codeblock-preview-interaction.zh.md)取代这一默认选择，同时继续将操作放在标题栏中。

**渲染每个流式片段。** 未完成的图表通常无效，反复布局会与文本流式输出争用资源。消息定稿可提供完整源码。

**在 Chat 内部渲染，或添加通用预览注册表。** 使用普通属性的共享基础组件即可满足复用，无需另加注册表或功能插件依赖。这遵循[共享控件规则](../architecture/2026-09-05-shared-client-control-primitives.zh.md)。

**通过 `CodeBlock.preview` 传入已渲染 JSX。** 调用方创建的元素会把预览所有权拆分到 renderer 与基础组件。标准数据描述让渲染、结果所有权与控件归入同一个组件 API。

**在 sandbox iframe 中预览 HTML。** HTML 预览需要清理策略、iframe 权限、独立文档布局和额外浏览器依赖。源码展示足以覆盖代码审阅场景，无需引入这组独立的安全与分发范围。

**把渲染标记插入 Chat。** SVG 样式和可执行行为会与应用共享文档。图片模式会禁用 SVG 行为，同时保留渲染结果。

**将 Viz.js 视为仅使用 MIT，或使用远程 Graphviz 服务。** 本地编译的 Graphviz 仍受其许可证约束；远程渲染会把对话内容发送到设备之外。内置渲染器保留源码可获取性与法律声明，无需网络渲染。

## Consequences

该功能改变呈现，不改变持久化消息、provider 请求、工具或 Host API。`SourcePreview` 同时按源码与 renderer 关联结果，在匹配结果完成前不发布预览内容。Mermaid 和 Graphviz 增加按需加载的浏览器资源，并在浏览器线程上执行布局。取消无法抢占进行中的布局；即使结果无法发布，Mermaid 仍会完成并释放测量 DOM。预览不提供编辑、导出、HTML 渲染或交互式图表链接。

组件测试覆盖源码复制、预览渲染、延迟完成、过期成功与失败、卸载、回退、取消、运行时加载失败与恢复。无密钥[浏览器场景](../../../../apps/web/tests/markdown-mermaid.e2e.ts)验证中文 Mermaid 流程图、时序图、无效源码、配置覆盖、不可执行 SVG 图片、真实图片解码、源码切换、中英文 UI 快照和已提供的许可证文本。声明检查固定已审查的包装层版本与原生源码下载地址，升级时须重新审查。
