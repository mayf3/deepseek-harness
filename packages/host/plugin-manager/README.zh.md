---
description: "面向已启动 profile 的插件管理：pluginManager 服务与 plugins Remote，负责安装、启用、停用与重试组合包、编辑用户层的行，并报告每个包的状态。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-plugin-manager

[English](README.md) | 中文

## 概述

`dsh-host-plugin-manager` 是改变一个运行中 profile 由什么组成的唯一地方。profile launcher 从组合包层与用户补丁文件组合出宿主树，并经 `profileRuntime` 在运行中重新组合；本服务驱动这一切：在 profile 目录运行 pnpm 安装或移除包，把组合包移入或移出 profile 的层列表并以结果重新组合树，在组合包的行启动失败时重新组合它，向 profile 的全局用户层或某个 agent preset 的用户层添加与移除行，并把 manifest、探针记录与在线树折叠成每个包一份视图。`plugins` Remote 暴露每一项操作；每次变更之后发出 `plugins/changed` 事件，安装运行把 pnpm 的输出以 `plugins/install-log` 流式发出。客户端包通过 [`api-remotes`](../../api/remotes/README.zh.md) 装配消费该 Remote。

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

把这一行挂在宿主组合里插件清单旁边；web 组合包已经这么做了。该行只注入 Loader，并在每次调用时解析 profile runtime，因此不经 profile launcher 启动的组合仍能启动，只是每次调用都回答 `plugins/unavailable`。

### 一份包视图说了什么

`plugins/list` 为 profile 知道的每个包返回一份视图：模板组合包与已安装的组合包，以及其他每个已安装的依赖。视图携带 manifest 事实（名字、版本、标题、描述、`engines.dsh`），这个包是什么（`bundle`、`plugin` 或 `library`），谁提供它（`builtin` 或 `external`），它的行何时挂载（`boot` 或 `runtime`），是否已安装与已启用，以及折叠出的 `status`：已启用的组合包按活跃行的多少是 `running`、`partial` 或 `failed`；已安装但不在层列表中的组合包是 `disabled`；探针拒绝时是 `not-enableable` 并附原因；在启动时才应用变更的 profile 上 manifest 与在线树不一致时是 `restart-required`；库或插件模块是 `plain`，它们被添加进组合而不是被启用。组合包已组合时行来自在线树——阶段、被谁停用，以及隔离行记录的失败——否则来自探针记录，id 保持各自 patch 声明的样子。`addable` 列出包在 `dsh.plugins` 里声明的模块，各自带默认配置与探针的判定。

### 安装与启用

`plugins/install` 接受一个 pnpm spec——registry 名字、`github:` 或 git URL、tarball、绝对路径——在 profile 目录运行 `pnpm add`，记录 pnpm 写进 `dependencies` 的内容，在子进程里探测每个新包，并让新组合包保持停用，除非调用方要求 `enable`。pnpm 的输出以带本次 `jobId` 的 `plugins/install-log` 分块到达；最后一块携带退出码。非零退出、spawn 失败或超时都以 `plugins/install-failed` 与日志尾部让调用失败。

`plugins/enable` 把已安装的组合包放进层列表，并在 live profile 上经 profile runtime 带着它重新组合树。这次重新组合就是 Loader 自己的事务：树拒绝的组合包——`boot` 阶段而行抛错的组合包——回滚，层列表恢复，调用以点名原因的 `plugins/enable-failed` 失败，而原本运行的树继续运行。`runtime` 阶段而行失败的组合包则被隔离：调用成功，视图报告该行的失败，`plugins/retry` 从头重新组合它。`plugins/disable` 是反向操作；模板组合包不是依赖，无法停用。在 `patchReload` 为 `startup` 的 profile 上，两者只写 manifest 并报告 `effect: 'restart'`。

`plugins/uninstall` 在组合包已启用时先停用它，删除每一条点名该包模块的用户层行，运行 `pnpm remove`，并忘掉探针记录。

### 用户层里的行

`plugins/addRow` 把一条点名该包某个模块的行——`plugin` 包的主导出，或某个 `dsh.plugins` 条目——插入 profile 的全局 `cordis.patch.yml`（`target: { kind: 'global' }`）或某个 agent preset 的用户层（`{ kind: 'preset', preset }`，经 roster 的 `overlayPathFor`）。行 id 未给出时由包名与子路径派生；已被占用的 id 以 `plugins/row-conflict` 失败。`plugins/removeRow` 移除一条插入的行，`plugins/setRowDisabled` 为任意行写入或移除 `disabled: true`——只写拒绝，因此组合包自己的 `!!js` 门被恢复而不是被覆盖。全局层当场在线重新组合；preset 的层在其下一个常驻代际生效。

`plugins/dependents` 说明停用或移除一个包会搁浅什么：其行提供而包外的行注入的服务，以及点名其模块的用户层行。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `pnpmCommand` | `pnpm` | 可执行文件，与 `dsh plugin` 命令一样经 `PATH` 解析。 |
| `installTimeoutMs` | `600000` | 单次安装或移除运行的上限。 |
| `probeTimeoutMs` | `20000` | 单次包探测的上限。 |
| `installLogTailBytes` | `16384` | 安装失败时报告多少尾部输出。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

### 一份 manifest，两个写入者

每次变更都重新读取 profile manifest，并通过 `dsh plugin` 命令所用的同一组 app-boot 助手（`reconcileInstalledBundles`、`enableBundle`、`disableBundle`）写回，因此 CLI 与管理器对这个文件永远不会有分歧。`dependencies` 记录装了什么；`dsh.profile.bundles` 记录启用了什么。

### pnpm 经 `node:child_process` 运行

subprocess seam 会清洗形似密钥的变量且没有 shell 模式，而 pnpm 既需要用户的 registry、代理与鉴权设置，在 Windows 上又需要解析其 `.cmd` shim 的 shell。于是管理器按 CLI 的方式生成 pnpm：带父进程环境、Windows 上开 `shell`，并自己流式读取子进程的输出。

### 重试即先停用再启用

Loader 的事务性更新不会碰未改变的行，因此一条失败的隔离行在普通的重新组合中不会重新启动。重试把组合包移出层列表再放回去：两次重新组合，manifest 首尾如一。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `PluginManager`：`pluginManager` 服务、`plugins` Remote 方法、pnpm 运行器与视图折叠 |
| [`src/types.ts`](src/types.ts) | wire 载荷、`plugins/changed` 与 `plugins/install-log` 事件，以及 `plugins/*` 失败码 |
| — | 不发布运行时不变量伴随件；每份视图都在每次调用时从 manifest、探针缓存与 Loader 持有的状态折叠而来。 |

Typert 生成 `./typert` 与 `./remote` 暴露的宿主与客户端 Remote 工件。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当管理器的契约还不够时读这些：它驱动的运行时、它编辑的文件，以及渲染它的界面。

- [App boot](../../boot/app-boot/README.zh.md)——profile runtime、外部组合包隔离与包探针。
- [补丁文件](../../util/patch-file/README.zh.md)——用户层的行如何写入。
- [Agent presets](../../preset/agent-presets/README.zh.md)——preset 目标所写的每预设用户层。
- [插件清单](../plugin-inventory/README.zh.md)——本服务旁边的行级只读投影。

-----

<a id="model-experience"></a>
## 模型体验

无，宿主侧的插件管理器不注册任何面向模型的东西；它组合出的行各自拥有自己做出的注册。

#### KV Cache 影响

无；本包既不组装也不发送 provider 请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定管理器不会为客户端做什么。它们是当前包的约束，不是任务清单。

- **更新已加载的包需要重启**——Node 按 URL 缓存 ESM 模块，hoisted 安装下路径不变；经 `install` 做的 `pnpm update` 改写了文件，但运行中的树在进程重启前一直用旧模块。
- **依赖检测止于注入**——注册型依赖（工具、LLM 适配器）没有 `inject` 边，因此 `dependents` 无法点名只读取该包所注册内容的行。
- **preset 的行不在线组合**——管理器写入 preset 的层；之后创建的会话组合它，已在运行的会话保持其代际。
- **尚无 `engines.dsh` 检查**——该范围只被报告，不对运行中的 harness 版本强制执行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
