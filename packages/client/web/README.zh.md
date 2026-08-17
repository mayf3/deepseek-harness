# @deepseek-ai/dsh-client-web

[English](README.md) | 中文

Web 启动内核：`new AppWebEntry(el, seams?).run()` 分两个阶段挂载客户端。模块阶段认领 HTML parser 预载的 `@deepseek-ai/dsh-client-modules` factory，基于宿主提供的 `window.__DSH_BOOT__` 图构建模块系统，接纳 queue 中的 runtime factory，并预取 `immediately` 层级。插件阶段挂载仓库内置的 Cordis Loader，通过 Loader 的 `internal` 接口注入该模块系统，创建全部图 entry，并等待每个 fiber 进入 ACTIVE。随后它把带标记的启动 DOM 交给动态 UI 渲染器的 `ctx.uiRenderer.mount(el)` 操作；渲染器先 hydrate 该 DOM，再切换到完整 UI。名册、parser 预载项和预取标记归宿主图所有；本包只额外加入已接纳的 modules 启动 entry。

启动页只使用原生 DOM 与本地 CSS，因此客户端 bundle 或插件激活失败时仍能显示。其回退字体和颜色与加载期间到达的主题 token 一致。fiber 更新会保留同一个 spinner 节点，并在 entry 首次进入 active 时增长其 CSS 圆弧；hydrate 会继续保留该节点及其动画相位，直到应用提交。React 挂载、slot 渲染、应用组装和浏览器标题投影位于 [`ui-renderer`](../ui-renderer/README.md)。modules 是唯一通过 `registerStatic` 注册的包：普通 `lib/client.js` 仍是其 graph row 产物，但内核必须在模块系统能够加载任何内容前认领并物化该 factory。

`PLATFORM_MODULES`（src/platform.ts）是外壳播种共享模块的唯一事实来源。它与 `PRELOADED_CLIENT_EXTERNALS` 一起定义全部动态 bundle 的隐式 external 基座；`dsh.client.external` 只添加基座之外的精确请求。

可选的覆盖参数 `seams` 会为外部 `<script>` 执行无法到达页面上下文的环境转发模块系统的 `loadBundle` 传输覆盖（`BootSeams`）；普通浏览器调用方省略此参数。

## 模型体验

无。入口外壳负责启动浏览器插件树；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **应用会等待完整名册**：只要一个 entry 失败，不依赖框架的启动页就会保留并逐项报告；不支持部分 UI 可用。
