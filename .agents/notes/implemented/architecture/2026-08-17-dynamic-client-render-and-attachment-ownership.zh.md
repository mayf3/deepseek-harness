# Agent Note: 客户端渲染与附件呈现的动态归属

Status: implemented

[English](2026-08-17-dynamic-client-render-and-attachment-ownership.md) | 中文

## 问题

宿主编写的客户端图管理浏览器插件，但三条呈现路径位于其生命周期之外。Web 内核创建 React 根和由外壳持有的组装伪 entry，`ui-conversation` 以包值形式导入附件组件，外壳还导入 ui-theme 的全局样式。因此，禁用、失败或重载某个插件时，并不能同时管理属于该插件的全部渲染与 CSS。

加载与失败页面的要求正好相反：包括渲染器在内的任何动态插件激活失败时，它都必须保持可用。它不能依赖自己正在报告其失败的 React 树。

## 决定

`@deepseek-ai/dsh-client-web` 是不依赖框架的启动内核。它通过 DOM 操作与本地 CSS 回退绘制加载和失败页面，构造客户端模块系统与 Cordis Loader，创建静态接纳的 modules 启动 entry 和宿主图中的每个 entry，并等待所有 fiber 进入 ACTIVE。随后它解析 `ctx.uiRenderer`，把现有容器交给 `mount()`。

`@deepseek-ai/dsh-client-ui-renderer` 是带 `immediately` 标记的动态客户端插件。它持有 React slot outlet、SessionProvider 与 observable 到 uSES 的绑定。`slots`、`sessions` 与 `layout` 激活后，它安装 slot 渲染器、提供 `ctx.uiRenderer`、在 `mount()` 时创建 React 根、投影当前会话标题，并执行唯一一次上下文级 `renderSlot('root')` 调用。其服务、渲染器安装和 React 根都随各自持有方 dispose。

`ui-conversation` 声明 `conversation.input.attachments` 与 `conversation.message.images`，并提供附件数据、回调、经会话授权的图片加载及其 locale seat。`ui-attachment` 通过 `ctx.slots.inject()` 等待这些声明，再注册草稿附件栏／拖放目标和历史图片画廊／灯箱。React 实现仍是包内值；跨插件组合通过 slot 完成。这项包集成决策取代[附件展示 Note](../feature/2026-08-11-web-attachment-display-alignment.md)中的直接导入规则，但不改变该 Note 的视觉与交互决策。

ui-theme 从客户端 entry 导入自己的五份全局样式表。共享客户端 bundle 预设会编译普通 CSS 与 CSS Modules，并在 bundle 物化时注入插件持有的 style 标签，因此卸载或重载 ui-theme 时，其全局 CSS 会随服务的同一生命周期删除或替换。Web 内核只保留挂载默认值与自给自足的启动页配色。

React、React DOM、Cordis、ui-slots 与 ui-primitives 仍是保持单一浏览器身份的静态平台模块。动态 ui-renderer bundle 消费这些共享模块并持有渲染副作用。

## 验证

组件测试固定启动页、文档标题、应用树、附件 entry 与 dispose 行为。组装后的构建 bundle 启动测试会运行真实模块表与动态 entry，客户端 bundle CSS 测试则证明全局样式会编译成受监视、由插件持有的注入器。浏览器回放测试覆盖从不依赖框架的页面到渲染应用的完整交接。

## 备选方案

**保留外壳持有的应用组装伪 entry。** 否决：它仍不在宿主图中，而且会把渲染归属变成特殊 Loader 路径，尽管该组装只有普通服务依赖与生命周期副作用。

**保留导出的附件原子组件并由 ui-conversation 导入。** 否决：直接导入组件会绕过独立插件组合与重载归属。持有方数据仍通过带类型的 slot props 直接传递；只有呈现选择是动态的。

**把 ui-theme 样式留在外壳的基础样式表中。** 否决：主题插件缺失或失败时，主题 CSS 仍会生效，而且不会参与插件重载清理。

**用 React 渲染失败页面。** 否决：渲染服务或 React 树失败时，不能连同浏览器中唯一的诊断一起移除。

## 结果

宿主图包含每个动态渲染持有方，HMR 通过插件生命周期替换附件呈现、渲染组装与主题 CSS。渲染服务失败时会留下可读的 DOM 失败页面，而不是空白 React 挂载点。有意省略 ui-attachment 会让其可选 slot 保持为空；随产品交付的 Web 组合包含该插件，而配置中存在但激活失败的 entry 会阻止完整应用交接。

应用首个 React 帧仍会等待完整客户端名册。外壳仍静态打包平台模块身份；由于 ui-theme CSS 要等到该插件物化后才可用，启动页还要维护一小套私有的明暗配色。
