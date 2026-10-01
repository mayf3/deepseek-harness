# Agent Note: HMR 包配置失效

Status: implemented

[English](2026-09-30-profile-package-refresh-and-manifest-invalidation.md) | 中文

## Problem

- **包配置与模块求值使用独立缓存。** 清理插件的模块缓存不会刷新 Node 用于 exports、main、imports 和格式判断的 package.json 字段。package.json 也可以被作为 JSON 模块导入，此时其消费方需要普通的模块重载。

## Decision

### 职责

| 负责方 | 做什么 | 不做什么 |
|---|---|---|
| HMR（`packages/boot/hmr`） | 使包配置失效，并保留作为 JSON 模块加载的 manifest 的普通重载 | 不因仅作为配置的 manifest 重载插件；不处理 `node_modules` 包替换 |

### HMR 包配置失效

HMR 的文件变化分派中，文件名为 `package.json` 且不在 `node_modules` 内的变化，交给 `PackageManifests.invalidate()`。位于宿主依赖图中的 manifest 仍请求宿主重载；作为 JSON 模块加载的 manifest 仍重载消费方。仅作为配置的 manifest 不安排模块重载。配置专属路径仍由其独立 watcher 处理。同一批的源码变化随后重载。

`invalidate(manifest)` 把该目录登记为已失效，之后：

- 位于该目录下的 package.json 读取、scope 查询、type 查询、最近 package.json 查询，都按当前磁盘解析。消费方经由链接路径访问时，按真实目录判断归属。
- 清空 ESM `ResolveCache`。其条目不记录查询过的全部 manifest，包入口也可能解析到包目录之外。
- 基于相同原因清空 CommonJS `_pathCache`。无关请求重新计算解析结果，不卸载其模块。
- 使用默认 resolver 的 CommonJS 加载把重新解析的文件名交给原生 loader。其私有请求别名不再选中旧入口，已缓存的模块实例保持不变。

仅使配置失效不会改变已加载模块。Loader entry 保留导出规范化之前的原始导入结果。HMR 将已导入的 Node 模块对象与缓存中 ModuleJob 的模块命名空间按对象身份匹配，重载已加载 URL。所有匹配的 entry 记录，包括已停用的 entry，仅在重载成功后更新，失败时保持不变。停止并重新启动 Loader entry 时，会重新按包名解析并选择新入口。

entry 名称以配置树 base URL 为作用域，并保留所有不同的已导入命名空间。尚未初始化的 entry 只登记名称，不抹去已加载的命名空间；仅在没有记录命名空间或入口为 `cordis:` 内置模块时按名称解析。依赖分析考虑每个已记录模块。共享插件运行时的 entry 使用同一次替换操作，但每个 Loader entry 按自身原命名空间选择替换实现。模块导入与导出规范化在移除旧运行时之前完成。导入或激活失败时，恢复原来的模块和插件实现，并清理已部分激活的替换实例。

没有 Loader entry 的实例不具备已记录的模块身份。如果共享运行时的替换模块具有不同的插件回调，HMR 会报告歧义错误并回滚，而不是将该实例随意分配给某个模块。

包配置失效实现在 `packages/boot/hmr/src/package-manifest.ts`，封装其使用的 Node internal 接口。`index.ts` 分派 manifest 变更，并按模块身份定位已加载 entry。HMR 的 `node_modules` 排除规则不变。

| 接口 | 动作 |
|---|---|
| modules binding 的 `readPackageJSON`、`getPackageScopeConfig`、`getPackageType` | 替换：路径位于已失效目录时按当前磁盘解析，其余调用原生方法 |
| `package_json_reader.getNearestParentPackageJSON` | 替换：已失效目录绕过它的 JS 缓存；没有 manifest 时返回原生的缺失结果 |
| ESM Loader 的 `ResolveCache` 实例 | 临时替换原型的 `get`，取得实例后立即恢复，再清空解析缓存 |
| CJS `Module._pathCache` | 清空请求到文件名的缓存 |
| CJS `Module._load` | 默认 resolver 的请求按解析后的文件名加载；内置模块及注册的 resolve hooks 保留原路径 |

binding 的 `getNearestParentPackageJSON` 只被 `package_json_reader` 自己调用，不替换。每个 HMR 实例拥有独立的配置缓存，在第一次失效时安装 hook，并在服务销毁时恢复，同时清理 watcher 和重载队列。

### 后续工作

- 不支持 `node_modules` 内在线替换、同路径重装、link 换目标及跨包重载传播。包更新需要重启进程；这不保证每个管理操作的结果都已正确报告这一要求。
- 使用异步 loader 线程的 TSX 版本，其线程内包配置不受这些 hook 管理。线程同步留待后续；本次不提供通用 Worker 缓存同步。
- 注册了同步 resolve hooks 时，CommonJS 私有请求缓存刷新留待后续；这些请求保留原有 loader 行为。
- 销毁 HMR 会恢复原生 reader，其此前缓存的配置可能重新可见。跨 HMR 替换保留失效状态留待后续。

## Alternatives considered

**让 HMR 支持 `node_modules` 内的包重载。** 这需要沿包含 `node_modules` 的模块图确定受影响插件，防止共享库和 Cordis 被重复求值，还要处理动态 import 漏边、模块副作用和 Worker。本次不做，这些场景继续要求重启。

**package.json 变化时重载所有插件。** 仅作为配置的 manifest 不要求模块求值。实际作为 JSON 模块导入的 manifest 保留普通的依赖驱动重载。

**按插件名重新 import 被重载的插件。** 这能让入口改名随源码重载生效，但会改变 `partialReload` 以已加载 URL 为重载单位的规则。入口改名在 Loader entry 重启时已经生效，所以本次不改。

**每个 entry 名称只保留一个命名空间。** 名称和 base URL 相同的 entry，可能在 manifest 变化前后加载了不同模块。只保留最早或最后一个命名空间会遗漏仍在使用的模块；尚未初始化的 entry 也不能抹去其他 entry 的已导入命名空间。

## Verification

| 覆盖面 | 位置 |
|---|---|
| 失效后的 exports、main、imports、type、scope、最近 package.json，原生 reader 对照，实际 CommonJS 加载及旧模块实例保留，node_modules 边界，恢复 | `packages/boot/hmr/tests/package-manifest.spec.ts` |
| 配置专用 manifest、JSON 模块与宿主重载、源码重载、同名及共享运行时的 entry、导入与激活失败回滚、entry 重启和 node_modules 排除规则 | `packages/boot/hmr/tests/package-manifest-dispatch.spec.ts` |

测试不需要 API key，不调用模型。

## Consequences

- 在支持的线程内，package.json 配置读取使用更新后的字段；JSON 模块保留自己的重载行为。上述模块、loader 线程及 Worker 的独立限制仍然适用。
- 包配置读取改由 JS 解析 package.json，需要与原生读取保持字段和错误语义一致；测试在 Node 22、24、26 上与原生读取逐项比较。
- 依赖多个 Node internal 接口，Node 升级时需要重跑这些测试。
