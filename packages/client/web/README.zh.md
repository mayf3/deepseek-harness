# @deepseek-ai/dsh-client-web

[English](README.md) | 中文

Web 启动内核：`new AppWebEntry(el, seams?).run()` 分两个阶段挂载客户端。模块阶段基于宿主提供的 `window.__DSH_BOOT__` 图构建 `@deepseek-ai/dsh-client-modules`，并预取 `immediately` 层级。插件阶段挂载仓库内置的 Cordis Loader，通过 Loader 的 `internal` 接口注入该模块系统，创建全部图 entry，并等待每个 fiber 进入 ACTIVE。随后它调用动态渲染服务的 `ctx.appShell.mount(el)` 操作，以完整 UI 替换启动页。名册与预取标记归宿主图所有；本包只额外加入静态接纳的 modules 启动 entry。

启动页只使用原生 DOM 与本地 CSS，因此客户端 bundle 或插件激活失败时仍能显示。React 挂载、slot 渲染器、应用组装和浏览器标题投影位于 [`render-service`](../render-service/README.md)。modules 包是唯一通过 `registerStatic` 注册的插件包，因为模块系统无法加载自身。

`PLATFORM_MODULES`（src/platform.ts）是共享模块接口的唯一真源：种子表 key、tsdown 客户端 external 和 vite alias 集都是它的投影。

可选的覆盖参数 `seams` 会为外部 `<script>` 执行无法到达页面上下文的环境转发模块系统的 `loadBundle` 传输覆盖（`BootSeams`）；普通浏览器调用方省略此参数。

## 模型体验

无。入口外壳负责启动浏览器插件树；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **应用会等待完整名册**：只要一个 entry 失败，不依赖框架的启动页就会保留并逐项报告；不支持部分 UI 可用。
