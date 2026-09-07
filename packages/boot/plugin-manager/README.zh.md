---
description: "面向 dsh profile 的插件管理：dsh plugin 命令与 Web 宿主共用的安装器，以及在已启动 profile 上启用、停用、重试、编辑用户层的行并报告每个包的管理器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-plugin-manager

[English](README.md) | 中文

## 概述

`dsh-plugin-manager` 是改变一个 profile 的插件的地方，不带任何 Remote 协议。`PluginInstaller` 只需要磁盘上的 profile：在 profile 目录运行 pnpm，在子进程里探测一次运行新增的每个包，并把在 profile 里没有位置的包再移除——`dsh plugin add` 命令在任何插件启动之前就用它。`PluginManager` 需要已启动的树：把组合包移入或移出 profile 的层列表并经 `profileRuntime` 重新组合树，在组合包的行失败时重新组合它，向 profile 的全局用户层或某个 agent preset 的用户层添加与移除行，说明停用一个包会搁浅什么，并把 manifest、探针记录与在线树折叠成每个包一份视图。每次拒绝或失败都是一个带 `plugins/*` 码的 `PluginOperationError`；Web 宿主的 [`dsh-host-plugin-manager`](../../host/plugin-manager/README.zh.md) 把管理器暴露为 `plugins` Remote，并把每个失败转成同码的 Remote 错误。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 不启动也能安装

用 profile 目录、安装锚点（dsh 应用的 `package.json`）、一个回答 profile 已组合层列表的 `loadProfile`、工具边界，以及 pnpm 输出的去处构造 `PluginInstaller`，然后 `add(spec)` 或 `remove(name)`：

```ts
const installer = new PluginInstaller({
  profileDir, profileName: 'web', installAnchor,
  loadProfile: () => loadProfile('dsh', 'web', installAnchor, undefined, { userLayer: false }),
  config: { pnpmCommand: 'pnpm', installTimeoutMs: 600_000, probeTimeoutMs: 20_000, installLogTailBytes: 16_384 },
  installLog: (chunk) => process.stdout.write(chunk.text),
})
const outcome = await installer.add('@acme/dsh-sql-tool')
```

`add` 接受一个 pnpm spec——registry 名字、`github:` 或 git URL、tarball、绝对路径——运行 `pnpm add`，记录 pnpm 写进 `dependencies` 的内容，并探测每个新包。`pnpm add` 成功还不等于装好了插件：既不声明组合包也不声明插件模块的包，或者某个行 id 已被已组合层占有的组合包，会再以 `pnpm remove` 移除并连同原因列在 `removed` 里；探针拒绝的包保留在原处，留给视图说明。新组合包保持停用并列在 `installedOnly` 里，由调用方决定是否启用——CLI 一律启用，Web 宿主只在被要求时启用。非零退出、spawn 失败或超时都以 `plugins/install-failed` 与日志尾部让调用失败，并把 profile manifest 恢复到运行前的样子。

### 管理已启动的 profile

在 Cordis 上下文之上构造 `PluginManager`，并交给它按调用读取所需之物的读取器——profile runtime、preset roster 的层、运行中的 agent 数——这样一个后来才有或始终没有其中之一的组合在调用时得到回答，而不是在挂载时：

```ts
const manager = new PluginManager(ctx, {
  config,
  runtime: () => ctx.get('profileRuntime'),
  presets: () => ctx.get('agentPresets'),
  runningAgents: () => (ctx.get('agents')?.list() ?? []).filter(agent => agent.status === 'running').length,
})
```

`list` 为 profile 知道的每个包返回一份视图：模板组合包与已安装的组合包，以及其他每个已安装的依赖。视图携带 manifest 事实（名字、版本、标题、描述、`engines.dsh`），这个包是什么（`bundle`、`plugin` 或 `library`），谁提供它（`builtin` 或 `external`），它的行何时挂载（`boot` 或 `runtime`），是否已安装与已启用，以及折叠出的 `status`：已启用的组合包按活跃行的多少是 `running`、`partial` 或 `failed`；已安装但不在层列表中的组合包是 `disabled`；探针拒绝时是 `not-enableable` 并附原因；在启动时才应用变更的 profile 上 manifest 与在线树不一致时是 `restart-required`；库或插件模块是 `plain`，它们被添加进组合而不是被启用。组合包已组合时行来自在线树——阶段、被谁停用，以及隔离行记录的失败——否则来自探针记录，id 保持各自 patch 声明的样子。`addable` 列出包在 `dsh.plugins` 里声明的模块，各自带默认配置与探针的判定。

`add` 就是安装器的 `add` 加上运行中 agent 数的守卫，`enable` 让每个新装的组合包一并进入层列表。`enable` 把已安装的组合包放进层列表，并在 live profile 上经 profile runtime 带着它重新组合树。这次重新组合就是 Loader 自己的事务：树拒绝的组合包——`boot` 阶段而行抛错的组合包——回滚，层列表恢复，调用以点名原因的 `plugins/enable-failed` 失败，而原本运行的树继续运行。`runtime` 阶段而行失败的组合包则被隔离：调用成功，视图报告该行的失败，`retry` 从头重新组合它。`disable` 是反向操作；模板组合包不是依赖，无法停用。在 `patchReload` 为 `startup` 的 profile 上，两者只写 manifest 并报告 `effect: 'restart'`。`uninstall` 在组合包已启用时先停用它，删除每一条点名该包模块的用户层行，运行 `pnpm remove`，并忘掉探针记录。

`addRow` 把一条点名该包某个模块的行——`plugin` 包的主导出，或某个 `dsh.plugins` 条目——插入 profile 的全局 `cordis.patch.yml`（`target: { kind: 'global' }`）或某个 agent preset 的用户层（`{ kind: 'preset', preset }`，经 roster 的 `overlayPathFor`）。行 id 未给出时由包名与子路径派生；已被占用的 id 以 `plugins/row-conflict` 失败。`removeRow` 移除一条插入的行，`setRowDisabled` 为任意行写入或移除 `disabled: true`——只写拒绝，因此组合包自己的 `!!js` 门被恢复而不是被覆盖。全局层当场在线重新组合；preset 的层在其下一个常驻代际生效。`dependents` 说明停用或移除一个包会搁浅什么：其行提供而包外的行注入的服务，以及点名其模块的用户层行。

管理器一次只跑一个变更——上一个还在跑时再调用会以 `plugins/busy` 失败并点名正在进行的操作——`add` 与 `uninstall` 在有会话运行时拒绝改动 `node_modules`，报 `plugins/agents-running`。每次变更之后在上下文上发出 `plugins/changed` 事件，安装运行把 pnpm 的输出以 `plugins/install-log` 分块发出。

### 失败

每次拒绝或失败都是一个 `PluginOperationError`，带稳定的 `code` 与按码定型的 `details`：`plugins/unavailable`（没有 profile runtime，或 preset 目标没有 roster）、`plugins/not-installed`、`plugins/not-enableable`、`plugins/enable-failed`、`plugins/install-failed`、`plugins/row-conflict`、`plugins/busy`、`plugins/agents-running`，以及请求点名了 profile 没有的东西时的 `plugins/bad-request`。`pluginOperationFailureOf` 把捕获到的值收窄为按码区分的联合。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

### 一份 manifest，两个写入者

每次变更都重新读取 profile manifest，并通过 `dsh plugin` 命令转发的动词所用的同一组 app-boot 助手（`reconcileInstalledBundles`、`enableBundle`、`disableBundle`）写回，因此 CLI 与 Web 宿主对这个文件永远不会有分歧。`dependencies` 记录装了什么；`dsh.profile.bundles` 记录启用了什么。

### pnpm 经 `node:child_process` 运行

subprocess seam 会清洗形似密钥的变量且没有 shell 模式，而 pnpm 既需要用户的 registry、代理与鉴权设置，在 Windows 上又需要解析其 `.cmd` shim 的 shell。于是安装器按 CLI 一直以来的方式生成 pnpm：带父进程环境、Windows 上开 `shell`，并自己流式读取子进程的输出。

### 重试即先停用再启用

Loader 的事务性更新不会碰未改变的行，因此一条失败的隔离行在普通的重新组合中不会重新启动。重试把组合包移出层列表再放回去：两次重新组合，manifest 首尾如一。

### 管理器自己读什么，别人交给它什么

管理器经它所在的上下文读取 Loader 树、reflect store 与 `pluginFailures` 注册表。属于别的包的东西——profile runtime、preset roster、agent 注册表——都经 `PluginManagerOptions` 以按调用读取的读取器交进来，roster 只以 `PresetLayers` 的形态交进来：层文件路径、preset 列表，以及行操作需要的组合行。因此本包只依赖 app-boot（其 `./patch-file` 导出负责读写各层），不依赖任何组合 preset 或 agent 的包。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `PluginInstaller`（pnpm 运行、探测、装后检查）与 `PluginManager`（已启动 profile 上的每项操作、互斥与视图折叠） |
| [`src/types.ts`](src/types.ts) | 载荷、`plugins/changed` 与 `plugins/install-log` 事件，以及 `plugins/*` 失败码及其 details |
| [`src/errors.ts`](src/errors.ts) | `PluginOperationError` 与按码区分的失败联合 |
| — | 不发布运行时不变量伴随件；每份视图都在每次调用时从 manifest、探针缓存与 Loader 持有的状态折叠而来。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当管理器的契约还不够时读这些：它驱动的运行时、它编辑的文件，以及调用它的表面。

- [App boot](../app-boot/README.zh.md)——profile runtime、外部组合包隔离与包探针。
- [补丁文件](../app-boot/README.zh.md#patch-files)——用户层的行如何读写。
- [Agent presets](../../preset/agent-presets/README.zh.md)——preset 目标所写的每预设用户层。
- [宿主插件管理器](../../host/plugin-manager/README.zh.md)——本管理器之上的 `plugins` Remote。
- [dsh 应用](../../../apps/cli/README.zh.md)——安装器之上的 `dsh plugin` 命令。

-----

<a id="model-experience"></a>
## 模型体验

无，插件管理不注册任何面向模型的东西；它组合出的行各自拥有自己做出的注册。

#### KV Cache 影响

无；本包既不组装也不发送 provider 请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定管理器不会为调用方做什么。它们是当前包的约束，不是任务清单。

- **更新已加载的包需要重启**——Node 按 URL 缓存 ESM 模块，hoisted 安装下路径不变；经 `add` 做的 `pnpm update` 改写了文件，但运行中的树在进程重启前一直用旧模块。
- **依赖检测止于注入**——注册型依赖（工具、LLM 适配器）没有 `inject` 边，因此 `dependents` 无法点名只读取该包所注册内容的行。
- **preset 的行不在线组合**——管理器写入 preset 的层；之后创建的会话组合它，已在运行的会话保持其代际。
- **尚无 `engines.dsh` 检查**——该范围只被报告，不对运行中的 harness 版本强制执行。
- **一次只有一个进程**——互斥在进程内，补丁文件写入器持文件锁，但 profile manifest 没有锁：CLI 与运行中的 Web 宿主同时编辑同一个 profile 不受支持。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
