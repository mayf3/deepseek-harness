# @deepseek-ai/dsh-client-render-service

[English](README.md) | 中文

负责 React 挂载的浏览器 Cordis 插件。[`dsh-client-web`](../web/README.md) 渲染不依赖框架的启动页并加载完整的客户端插件名册；所有 entry 激活后，它调用 `ctx.appShell.mount(container)`。本包提供该服务、安装 slot 渲染器、创建 React 根，并返回卸载 disposer。

插件在 `slots`、`sessions` 和 `layout` 就绪后激活。它的应用树投影当前会话标题，并执行全程序唯一一次 ctx 级 `renderSlot('root')` 调用。React、React DOM、ui-slots、ui-primitives 和 web-react 通过 web 外壳的静态模块表保持同一浏览器身份；本包则以动态客户端 bundle 到达。

## 模型体验

无。渲染服务只组装浏览器 UI，不贡献模型可见输入。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **应用首帧会等待全部客户端 entry**——启动内核只在 loader 名册稳定后交出挂载点。按区域就绪仍属暂缓事项。
