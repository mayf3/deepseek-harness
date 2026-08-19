# @deepseek-ai/dsh-client-modules

[English](README.md) | 中文

客户端模块系统：Node 内部 ESM loader 的浏览器端对等实现，以惰性 CJS 表实现。web 外壳挂载 vendored cordis Loader 来治理配置项（fiber 生命周期、inject 等待、update/refresh），并通过其 `internal` 约定注入该包的 `ClientModuleLoader`；vendored 一侧唯一的消费点是 `EntryTree.import`，因此替换 `internal` 恰好只会替换「插件代码如何到达」，不会改变其他内容。

惰性 CJS 模型（web2）：执行插件 bundle 只会注册其 factory（`window.__ModuleLoader__.load({id, factory})`）；每个模块主体的副作用（包括 CSS 注入）都位于 factory 闭包中，在物化时运行（`factory(require)` → 导出表层，并在 `loadCache` 中记忆化），不会在脚本执行时运行。如果 factory 依赖另一个已注册但尚未物化的模块，系统会递归物化它；图组合会把声明的动态请求提供方放在消费者之前，而 require 循环会抛出异常，因为 factory 形式的 CJS 无法提供部分导出。`<id>/client` 与裸 id 指向同一表层（一个插件 bundle 就是其包的客户端侧）。

Host 会先安装 `window.__ModuleLoader__`、预加载 application 批次，再执行阻塞 parser 的 bootstrap 批次。Queue 模式的 `load()` 保存 modules registration；`create()` 使用拒绝 external 的 bootstrap require 物化本包 factory，并调用其 `createClientModuleSystem` 导出。构造过程把同一组导出缓存为 modules row，并把同一个 facade 切换到 live registration。Bundle 通过模块闭包保留生成的系统，因此随后 Cordis `apply()` 能把同一实例提供为 `ctx.modules`，无需另一个页面全局变量。

解析分支顺序（`import(specifier)`）：平台种子词 → 外壳实例；记忆化记录 → 导出；模块图记录（`window.__DSH_BOOT__`）→ 登记其初始批次 factory；已登记 factory → 物化；其他情况一律抛出异常。这是构建时 bundle 纯度门禁的运行时镜像。交给 factory 的同步 `require` 采用相同顺序，但不含异步 graph-row 加载分支，并把观察到的边记录到模块记录中。`prefetch` 是第一阶段到达钩子；共享同一批次 URL 的 row 会共享一个进行中的脚本任务。`invalidate(id, rev)` 会丢弃非 bootstrap factory 与物化记录，并让该 row 改用带 revision 的独立脚本，因此 HMR（热模块替换）只重载一个插件，不会再次执行整批脚本。

Node 侧会扫描已启用的 Loader 配置项以发现 web `dsh.client` 包，解析并快照每个 `exports["./client"]` 及其可用 sourcemap，携带包专属 `dsh.client.external` 请求，并把动态提供方排在消费者之前。它为 modules row 生成 bootstrap 批次，为其余 row 生成 application 批次；每个批次都有按内容寻址的脚本，以及由现有插件 map 组合而成的 indexed Source Map v3 文件。HMR 仍可访问带 revision 的独立脚本与 map；所有版本化响应都不可变，revision 不匹配时返回 404，绝不在旧 URL 下提供新字节。源码启动会把宿主侧导入映射到 TypeScript 源码，但仍消费这些构建后的客户端导出；缺失文件共享一条构建说明，随后以包／路径列表列出各项，而无关的文件系统错误仍是独立故障。

`dsh.client.external` 是外壳播种的 React、Cordis 和静态 UI 库这一统一基座之外的可选精确 specifier 请求列表。请求由其命名的动态 package row 或精确静态表键回答；只有末尾 `/client` 会别名到 package row，并且不存在 provider 别名声明。纯类型 import 会被擦除，不产生请求。组合阶段会拒绝畸形请求、缺失提供方、自请求和同步请求环；import 与 prefetch 会在消费者物化前递归登记动态提供方。参见[共享模块与模块图](../AGENTS.md#shared-modules-and-the-module-graph)。

## 模型体验

无。模块 loader 属于浏览器侧内核机制；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **有意采用扁平模块图**：每个 bundle 是一个模块节点，其边只指向表中的叶节点；接口（`loadCache`/`edges`/`invalidate`）已经支持通用模块图，因此可以改变 externalization 粒度而不更改接口。
- **自身不维护卸载记录**：样式移除与 fiber 拆卸顺序属于 HMR 驱动器（`@deepseek-ai/dsh-client-hmr`）；loader 只在每条记录中登记其拥有的样式标签 id。
- **快照式提供会常驻产物字节**：Host 会在内存中保留每个 bundle、可选 sourcemap、带 revision 的独立响应及生成的批次；HMR 还会保留上一代批次。内存会随组合出的客户端产物增长为数份副本，以换取 immutable 响应和一代竞态容忍。
