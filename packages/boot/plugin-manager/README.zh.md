---
description: "面向 dsh profile 的插件管理：dsh plugin 命令与 Web 宿主共用的安装器，以及在已启动 profile 上启用、停用、重试、编辑用户层的行并报告每个包的管理器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-plugin-manager

[English](README.md) | 中文

## 概述

`dsh-plugin-manager` 通过 CLI 与 Web 宿主安装包并管理它们声明的插件行。安装读取元信息，不执行模块。管理器启停整份组合包层，编辑profile 用户 patch，重试失败并报告当前运行问题。失败携带 `plugins/*` 错误码；[Host 适配器](../../host/plugin-manager/README.zh.md) 通过 Remote 暴露这些操作。

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

用 profile 目录、安装锚点（dsh 应用的 `package.json`）、一个回答 profile 已组合层列表的 `loadProfile`、工具边界、pnpm 输出的去处，以及是否让 pnpm 上色，构造 `PluginInstaller`，然后 `add(spec)` 或 `remove(name)`：

```ts
import { loadProfile } from '@deepseek-ai/dsh-app-boot'
import { PluginInstaller } from '@deepseek-ai/dsh-plugin-manager'

declare const profileDir: string
declare const installAnchor: string

const installer = new PluginInstaller({
  profileDir, profileName: 'web', installAnchor,
  loadProfile: () => loadProfile('dsh', 'web', installAnchor, undefined, { userLayer: false }),
  config: { pnpmCommand: 'pnpm', installTimeoutMs: 600_000, installLogTailBytes: 16_384 },
  installLog: (chunk) => process.stdout.write(chunk.text),
  color: process.stdout.isTTY,
})
const outcome = await installer.add('@acme/dsh-sql-tool')
console.log(outcome.installed, outcome.removed)
```

`add` 在 profile 中执行 pnpm，核对 `dependencies`，并按当前行归属静态检查新组合包声明。冲突组合包会被移除并给出原因；未声明或声明不可读的包保持已安装。新组合包保持禁用，除非调用方启用。pnpm 执行失败会恢复运行前的 manifest，并通过 `plugins/install-failed` 报告日志尾部。

### 管理已启动的 profile

在 Cordis 上下文之上构造 `PluginManager`，并交给它按调用读取所需之物的读取器——profile runtime 和运行中的 agent 数——这样一个后来才有或始终没有其中之一的组合在调用时得到回答，而不是在挂载时：

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-app-boot'
import { PluginManager, type PluginToolingConfig } from '@deepseek-ai/dsh-plugin-manager'

declare const ctx: Context
declare const config: PluginToolingConfig

const manager = new PluginManager(ctx, {
  config,
  runtime: () => ctx.get('profileRuntime'),
  runningAgents: () => (ctx.get('agents')?.list() ?? []).filter(agent => agent.status === 'running').length,
})
console.log(await manager.list())
```

`list` 报告包身份、`bundle` / `plugin` / `unknown` 分类、安装与启用状态。运行行携带实际阶段与失败；禁用组合包显示静态 patch 声明。`addable` 只来自 `dsh.plugins`，包括表示主入口的 `.` 和声明的默认配置。行更新失败后，活跃实例可能保留先前配置。包的 `issues` 还报告其 patch 覆盖的失败行，但不转移这些行的归属。

`enable` 选择整份组合包层，并在实时 profile 中重组。逐行失败保留启用选择与成功的其他行；结果报告 `issues`，列表可显示 `partial` 或 `failed`。准备失败会撤销启用选择，并抛出 `plugins/enable-failed`。`disable` 移除整层，包括覆盖。`retry` 先禁用并等待清理，再启用。仅启动时生效的 profile 报告 `effect: restart`。实时 profile 中尚未应用的选择报告 `failed`，并保留实际运行的行；`restart-required` 只用于仅启动时生效的 profile。`uninstall` 禁用组合包、删除用户插入的引用、执行 pnpm remove。

`addRow` 将显式声明的 `dsh.plugins` 模块写入 profile 的全局 `cordis.patch.yml`。它保留声明的默认配置，检查目标行 id，不在挂载前 import。`removeRow` 删除用户插入。`setRowDisabled` 写入或删除 `disabled: true`，保留组合包自己的条件。全局编辑在实时 profile 中立即重组。`dependents` 报告注入依赖方与用户层模块引用。

管理器一次只跑一个变更——上一个还在跑时再调用会以 `plugins/busy` 失败并点名正在进行的操作——`add` 与 `uninstall` 在有会话运行时拒绝改动 `node_modules`，报 `plugins/agents-running`。每次变更之后在上下文上发出 `plugins/changed` 事件，安装运行把 pnpm 的输出以 `plugins/install-log` 分块发出，每块都写明所跑的命令行与所在的 profile 目录，开了颜色时还带着 pnpm 的 SGR 转义。

### 失败

每次拒绝或失败都是一个 `PluginOperationError`，带稳定的 `code` 与按码定型的 `details`：`plugins/unavailable`（没有 profile runtime）、`plugins/not-installed`、`plugins/not-enableable`、`plugins/enable-failed`、`plugins/install-failed`、`plugins/row-conflict`、`plugins/busy`、`plugins/agents-running`，以及请求点名了 profile 没有的东西时的 `plugins/bad-request`。`pluginOperationFailureOf` 把捕获到的值收窄为按码区分的联合。

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

重试移除整层，并等待已移除 fiber 清理完成后再添加。它不依赖合成 group，也不会静默补偿失败插件的副作用。

### 管理器自己读什么，别人交给它什么

管理器读取 Loader 条目、reflect 存储与条目自身诊断。profile 和 agent 信息通过逐次调用的读取器提供。[Host 适配器](../../host/plugin-manager/README.zh.md) 在状态稳定后将 Loader 生命周期变化转换为 `plugins/changed` 通知，包括等待中的行在提供方出现后恢复运行。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 包 API：类、选项、类型与失败码的 re-export |
| [`src/installer.ts`](src/installer.ts) | `PluginInstaller`：pnpm 流式输出、静态声明与装后检查 |
| [`src/manager.ts`](src/manager.ts) | `PluginManager`：已启动 profile 上的每项操作、一次一个的互斥、用户层编辑与依赖查询 |
| [`src/view.ts`](src/view.ts) | 将 manifest、声明与实际行状态组合为 `PluginPackageView`，并查询行归属 |
| [`src/modules.ts`](src/modules.ts) | 声明的 `dsh.plugins` 模块：行命名、派生行 id 及其 wire 视图 |
| [`src/helpers.ts`](src/helpers.ts) | 共享词汇：诊断前缀、工具边界、spawn 测试缝与 manifest 读取器 |
| [`src/types.ts`](src/types.ts) | 载荷、`plugins/changed` 与 `plugins/install-log` 事件，以及 `plugins/*` 失败码及其 details |
| [`src/errors.ts`](src/errors.ts) | `PluginOperationError` 与按码区分的失败联合 |
| — | 不发布独立运行不变量模块；每次调用直接从 manifest、静态声明与 Loader 状态生成视图。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当管理器的契约还不够时读这些：它驱动的运行时、它编辑的文件，以及调用它的表面。

- [App boot](../app-boot/README.zh.md)——profile runtime、外部组合包隔离与静态包声明。
- [补丁文件](../app-boot/README.zh.md#patch-files)——用户层的行如何读写。
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
- **尚无 `engines.dsh` 检查**——该范围只被报告，不对运行中的 harness 版本强制执行。
- **一次只有一个进程**——互斥在进程内，补丁文件写入器持文件锁，但 profile manifest 没有锁：CLI 与运行中的 Web 宿主同时编辑同一个 profile 不受支持。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
