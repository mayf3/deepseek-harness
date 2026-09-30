# Agent Note: HMR 包配置失效

Status: implemented

[English](2026-09-30-profile-package-refresh-and-manifest-invalidation.md) | 中文

## Problem

- **HMR 只处理模块内容，不处理 package.json。** `packages/boot/hmr` 在源码变化时清模块缓存，并按原 URL 重新 import。插件目录里的 package.json 不是模块，改了它，HMR 既不处理这个事件，也不清 Node 的包配置缓存（C++ 的 package.json 读取缓存、`package_json_reader` 的最近 package.json 缓存、ESM `ResolveCache`、CJS `_pathCache`）。之后的源码重载和新导入仍按旧的 exports、main、imports 解析，按旧的 type 判断格式。

## Decision

### 职责

| 负责方 | 做什么 | 不做什么 |
|---|---|---|
| HMR（`packages/boot/hmr`） | 监听范围内 package.json 变化时，让该包的配置缓存失效 | 不因 package.json 变化重载插件；不处理 `node_modules` |

### HMR 包配置失效

HMR 的文件变化分派中，文件名为 `package.json` 且不在 `node_modules` 内的变化，交给 `PackageManifests.invalidate()`，不进 `partialReload`。同一批里的源码变化随后照常重载，重载后的模块读到新配置。

`invalidate(manifest)` 把该目录登记为已失效，之后：

- 位于该目录下的 package.json 读取、scope 查询、type 查询、最近 package.json 查询，都按当前磁盘解析。消费方经由链接路径访问时，按真实目录判断归属。
- ESM `ResolveCache` 中，parent 位于该目录、或结果指向该目录的条目被删除。
- CJS `_pathCache` 中，结果或查找路径位于该目录的条目被删除。

已加载模块保持不变。重载的插件按已加载的 URL 重新 import，因此入口文件改名在 Loader entry 重新启动（例如停用后再启用）时生效，那时 Loader 按包名重新解析。

实现位于 `packages/boot/hmr/src/package-manifest.ts`，所需的 Node internal 接口都封装在这个文件里；`index.ts` 只增加分派、字段和卸载时的恢复。`node_modules` 的排除规则不变。

| 接口 | 动作 |
|---|---|
| modules binding 的 `readPackageJSON`、`getPackageScopeConfig`、`getPackageType` | 替换：路径位于已失效目录时按当前磁盘解析，其余调用原生方法 |
| `package_json_reader.getNearestParentPackageJSON` | 替换：已失效目录绕过它的 JS 缓存；没有 manifest 时返回原生的缺失结果 |
| ESM Loader 的 `ResolveCache` 实例 | 临时替换原型的 `get`，取得实例后立即恢复，再按 parent 删除条目 |
| CJS `Module._pathCache` | 删除落在已失效目录下的条目 |

binding 的 `getNearestParentPackageJSON` 只被 `package_json_reader` 自己调用，不替换。这些替换在第一次失效时安装，HMR 服务卸载时恢复。

### 不支持的场景

覆盖或升级 `node_modules` 里已安装的包、卸载后在同一路径重装，仍然需要重启。模块缓存、`node_modules` 的包配置缓存和 HMR 的 `node_modules` 排除规则都不变。

## Alternatives considered

**让 HMR 支持 `node_modules` 内的包重载。** 这需要沿包含 `node_modules` 的模块图确定受影响插件，防止共享库和 Cordis 被重复求值，还要处理动态 import 漏边、模块副作用和 Worker。本次不做，这些场景继续要求重启。

**package.json 变化时重载插件。** package.json 不是模块，改它不一定意味着需要重新求值；源码 HMR 本来就由源码变化驱动。失效之后，下一次源码重载或新导入自然会读到新配置。

**按插件名重新 import 被重载的插件。** 这能让入口改名随源码重载生效，但会改变 `partialReload` 以已加载 URL 为重载单位的规则。入口改名在 Loader entry 重启时已经生效，所以本次不改。

## Verification

| 覆盖面 | 位置 |
|---|---|
| 失效后的 exports、main、imports、type、scope、最近 package.json，与原生读取的一致性，node_modules 边界，恢复 | `packages/boot/hmr/tests/package-manifest.spec.ts` |
| HMR 分派：仅 manifest 变化不重载、同批源码重载读新 imports、entry 重启读新入口、node_modules 内不处理 | `packages/boot/hmr/tests/package-manifest-dispatch.spec.ts` |

测试不需要 API key，不调用模型。

## Consequences

- HMR 开发流程中改 package.json 的 imports、exports、main、type，下一次重载或新导入就会读到；package.json 本身不触发重载。
- 包配置读取改由 JS 解析 package.json，需要与原生读取保持字段和错误语义一致；测试在 Node 22、24、26 上与原生读取逐项比较。
- 依赖多个 Node internal 接口，Node 升级时需要重跑这些测试。
