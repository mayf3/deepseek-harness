---
description: "通过 Web 设置页或 agent 启停 profile 插件，并安装、删除或选择组合包。"
kind: "package-reference"
---

# @deepseek-ai/dsh-plugin-manager

[English](README.md) | 中文

## Summary

管理当前 profile 的插件，无需手动编辑配置。启停单个插件条目、选择已安装的组合包，以及安装或删除外部组合包。live profile 立即应用配置变化；仅启动时加载的 profile 在重启前保留运行中的组合。改动影响使用该 profile 的全部会话。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

基于 base 的 profile 提供管理服务。在 Web 设置中打开插件并选择插件列表，即可管理组合包和能唯一定位的全局插件条目。Agent 预设条目保持只读。`plugin_manager` 工具提供相同操作。

插件开关只写入 profile 的 `cordis.patch.yml` 中的 `disabled` 覆盖项。组合包开关修改 `package.json` 的有序 `dsh.profile.bundles` 列表。关闭保留依赖；开启追加到列表末尾，可能改变配置优先级。安装新组合包默认启用。home 和单次启动 patch 保留更高优先级。

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `outputBytes` | `16384` | 每次操作返回的 pnpm 诊断字节上限；完整输出保留在返回的日志路径中。 |
| `notificationDelayMs` | `250` | 合并操作通知的延迟毫秒数。 |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

服务与 `dsh plugin` 共用 [operations.ts](src/operations.ts) 中的包管理操作。启动器提供当前 profile，并串行执行文件监听和管理写入。每次刷新重新读取组合包选择与 patch 层，更新原有根 Include，并等待已移除插件释放资源及剩余 Loader 树稳定。包管理操作持有 profile manifest 锁；文件监听器在锁释放后读取完成的状态。

配置保存、包管理器完成和运行时激活分别报告。失败保留部分改动和诊断，不自动恢复文件或包。管理器直接读取文件和 Loader 状态，不维护第二份目标状态注册表，因此不发布单独的运行时不变式伴生入口。

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [App boot](../app-boot/README.zh.md)——profile 配置层与启动策略。
- [Plugin inventory](../../host/plugin-inventory/README.zh.md)——当前 Loader 和预设状态。
- [Plugin settings](../../client/ui-settings-plugin-inventory/README.zh.md)——Web 控件。

<a id="model-experience"></a>
## Model Experience

### Management tool

#### What the model sees

[`plugin_manager` 工具](../../../docs/tool-catalog.zh.md#plugin-manager) 列出插件条目和组合包，并执行影响整个 profile 的改动。结果包含保存状态变化、应用状态和包管理诊断。

#### Token effect

装配工具消费者时提供工具声明；每次调用追加返回的清单或改动结果。

#### KV Cache effect

工具结果追加到对话中。启停其他工具可能改变后续工具声明及其缓存复用。

### Configuration change notices

#### What the model sees

连续操作结果在 `notificationDelayMs` 内合并后注入每个受影响的存活 Agent。通知包含应用结果，达到配置的输出上限时标明省略的结果数，不会唤醒空闲 Agent。

#### Token effect

通知按需向每个受影响 Agent 追加用户消息上下文。

#### KV Cache effect

通知追加上下文，不改写先前消息。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- 替换已有包后需要重启进程，以加载新的 JavaScript 模块版本。
- 仅启动时加载的 profile 不能删除当前进程启动时使用的包；停止进程后使用 `dsh plugin`。
- 管理器不能关闭自身所需的管理组件、修改其他 profile 或编辑 agent 预设组合。
- 包管理失败可能留下部分依赖改动。诊断日志保留在 profile 的 `.plugin-manager/logs` 目录中。
- Desktop 包管理操作仍由 Desktop shell 负责。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
