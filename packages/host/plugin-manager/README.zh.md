---
description: "Web 宿主的 plugins Remote：pluginManager 作为 Typert 服务，把每次调用转接给已启动 profile 上的共享插件管理器，并把它的失败映射为 Remote 错误码。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-plugin-manager

[English](README.md) | 中文

## 概述

`dsh-host-plugin-manager` 把 `pluginManager` 挂载为 Typert 服务并暴露 `plugins` Remote——`list`、`add`、`uninstall`、`enable`、`disable`、`retry`、`setRowDisabled`、`dependents`——每个方法都转给建立在本上下文之上的 [`dsh-plugin-manager`](../../boot/plugin-manager/README.zh.md) `PluginManager`，每个 `plugins/*` 失败以同码的 `RemoteError` 过线。操作做什么、以及随之而来的 `plugins/changed` 与 `plugins/install-log` 事件属于那个包；本包只是从上下文读取 profile runtime 与 agent 注册表并交给它。客户端经 [`api-remotes`](../../api/remotes/README.zh.md) 装配消费该 Remote。

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

### Remote

`plugins/list`、`plugins/add`、`plugins/uninstall`、`plugins/enable`、`plugins/disable`、`plugins/retry`、`plugins/setRowDisabled` 与 `plugins/dependents` 携带管理器同名方法定义的参数与答复；[管理器 README](../../boot/plugin-manager/README.zh.md#use-this-package) 逐一说明。`./types` 导出原样 re-export 管理器的载荷类型，客户端只需导入一套词汇。

### 失败码

管理器的失败以同样的 `code` 与 `details` 作为 `RemoteError` 到达客户端：`plugins/unavailable`、`plugins/not-installed`、`plugins/not-enableable`、`plugins/enable-failed`、`plugins/install-failed`、`plugins/install-cancelled`、`plugins/busy` 与 `plugins/agents-running`，各自以管理器的 details 类型声明在 Remote 失败表里。管理器的通用拒绝 `plugins/bad-request` 以 Gateway 的 `gateway/bad-request` 过线。管理器抛出的其他错误原样传播，由 Gateway 报为 `gateway/internal`。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `pnpmCommand` | `pnpm` | 可执行文件，与 `dsh plugin` 命令一样经 `PATH` 解析。 |
| `installTimeoutMs` | `600000` | 单次安装或移除运行的上限。 |
| `installKillGraceMs` | `5000` | 强制终止前的宽限期。 |
| `installLogTailBytes` | `16384` | 安装失败时报告多少尾部输出。 |

-----

`plugins.cancelInstall(requestId)` 仅停止匹配的安装，并在清理完成后返回。`plugins/install-state` 区分准备、取消及应用阶段；应用阶段不可取消。`installKillGraceMs` 配置终止宽限期（默认 5,000 毫秒），独立于 `installTimeoutMs`。恢复限制见[安装器](../../boot/plugin-manager/README.zh.md)。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

### 转接，不是第二个管理器

适配器为一个 `PluginManager` 提供逐次调用的 profile 与 agent 读取器，转接各 Remote 方法并映射领域错误。它将原生条目与状态事件合并到一次读取中，等待 Loader 和已排队的 profile 重组完成后，仅在行诊断变化时发布 `plugins/changed` 通知。管理操作仍保留各自的变更通知。销毁会取消待发通知并移除监听器。测试可替换管理器、pnpm 启动器或静态元信息读取器。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `PluginManagerRemote`：`pluginManager` 服务、八个 `plugins` Remote 方法与 `remoteErrorOf` |
| [`src/types.ts`](src/types.ts) | re-export 管理器的类型，并把 `plugins/*` 码声明进 Remote 失败表 |
| — | 不发布运行时不变量伴随件；该行不持有自己的状态。 |

Typert 生成 `./typert` 与 `./remote` 暴露的宿主与客户端 Remote 工件。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当转接层的契约还不够时读这些：它背后的管理器，以及渲染它的界面。

- [插件管理器](../../boot/plugin-manager/README.zh.md)——每项操作做什么、事件与失败码。
- [App boot](../../boot/app-boot/README.zh.md)——管理器驱动的 profile runtime。
- [插件清单](../plugin-inventory/README.zh.md)——本服务旁边的行级只读投影。

-----

<a id="model-experience"></a>
## 模型体验

无，该 Remote 不注册任何面向模型的东西；管理器组合出的行各自拥有自己做出的注册。

#### KV Cache 影响

无；本包既不组装也不发送 provider 请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定该 Remote 不会为客户端做什么。它们是当前包的约束，不是任务清单。

- **管理器做不到的，Remote 也做不到**——[管理器的限制](../../boot/plugin-manager/README.zh.md#known-limitations-and-deferred-work)原样适用：已加载的包下次重启才更新，依赖检测止于注入，`engines.dsh` 只报告不强制。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
