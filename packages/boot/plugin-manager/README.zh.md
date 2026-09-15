---
description: "通过 Web 设置页或 agent 启停 profile 插件，并安装、删除或选择组合包。"
kind: "package-reference"
---

# @deepseek-ai/dsh-plugin-manager

[English](README.md) | 中文

## 概述

管理当前 profile 的插件，无需手动编辑配置。启停单个插件条目、选择已安装的组合包，以及安装或删除外部组合包。在 YAML 中启用 HMR 时，配置变化立即生效；未启用 HMR 时，运行中的组合保留到重启。改动影响使用该 profile 的全部会话。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [失败行为](#failure-behavior)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

基于 base 的 profile 提供管理服务。在 Web 设置中打开插件并选择插件列表，即可管理组合包和能唯一定位的全局插件条目。Agent 预设条目保持只读。`plugin_manager` 工具提供相同操作，默认禁用。

在 profile patch 中显式启用工具；使用预设的 Agent 还需要启用该预设中的 `tool-plugin-manager` 条目。

```yaml
- id: tool-plugin-manager
  disabled: false
```

插件开关只写入 profile 的 `cordis.patch.yml` 中的 `disabled` 覆盖项。组合包开关修改 `package.json` 的有序 `dsh.profile.bundles` 列表。关闭保留依赖；开启追加到列表末尾，可能改变配置优先级。安装新组合包默认启用。home 和单次启动 patch 保留更高优先级。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `outputBytes` | `16384` | 每次操作返回的 pnpm 诊断字节上限；完整输出保留在返回的日志路径中。 |
| `lockWaitMs` | `120000` | 获取 profile 写锁的最长等待毫秒数。 |
| `notificationDelayMs` | `250` | 合并操作通知的延迟毫秒数。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

服务与 `dsh plugin` 共用 [operations.ts](src/operations.ts) 中的包管理操作。启动器提供当前 profile；[DSH HMR](../hmr/README.zh.md) 串行执行模块重载、文件监听和管理写入。每次刷新重新读取组合包选择与 patch 层，更新原有根 Include，并等待已移除插件释放资源及剩余 Loader 树稳定。包管理操作持有 profile manifest 锁；文件监听器在锁释放后读取完成的状态。

结果包含最后尝试的阶段、目标、磁盘变化、应用状态和错误码。Web 词典呈现管理文案；pnpm 与 Loader 的诊断保持原样。无关的已有故障作为警告返回；新出现、配置变化后的故障，以及显式启用目标未激活，都会使操作失败。CLI 继承认证环境和终端描述符；service 使用清理后的环境并捕获输出。管理器直接读取文件和 Loader 状态，不维护第二份目标状态注册表，因此不发布单独的运行时不变式伴生入口。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [App boot](../app-boot/README.zh.md)——profile 配置层与启动策略。
- [Plugin inventory](../../host/plugin-inventory/README.zh.md)——当前 Loader 和预设状态。
- [Plugin settings](../../client/ui-settings-plugin-inventory/README.zh.md)——Web 控件。

<a id="model-experience"></a>
## 模型体验

### 管理工具

#### 模型看到什么

[`plugin_manager` 工具](../../../docs/tool-catalog.zh.md#deepseek-aidsh-plugin-manager) 列出插件条目和组合包，并执行影响整个 profile 的改动。结果包含保存状态变化、应用状态和包管理诊断。

#### Token 影响

装配工具消费者时提供工具声明；每次调用追加返回的清单或改动结果。

#### KV Cache 影响

工具结果追加到对话中。启停其他工具可能改变后续工具声明及其缓存复用。

### 配置变更通知

#### 模型看到什么

连续操作结果在 `notificationDelayMs` 内合并后注入每个受影响的存活 Agent。通知包含应用结果，达到配置的输出上限时标明省略的结果数，不会唤醒空闲 Agent。

#### Token 影响

通知按需向每个受影响 Agent 追加用户消息上下文。

#### KV Cache 影响

通知追加上下文，不改写先前消息。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 替换已有包后需要重启进程，以加载新的 JavaScript 模块版本。
- 仅启动时加载的 profile 不能删除当前进程启动时使用的包；停止进程后使用 `dsh plugin`。
- 管理器不能关闭自身所需的管理组件、修改其他 profile 或编辑 agent 预设组合。
- 包管理失败可能留下部分依赖改动。文件缺失的未启用依赖仍可删除。诊断日志保留在 profile 的 `.plugin-manager/logs` 目录中。
- 浏览器组合包变化需要刷新页面后才能加载当前 Client 模块图。管理结果描述 Host 激活状态。
- Desktop 包管理操作仍由 Desktop shell 负责。

<a id="failure-behavior"></a>
### 失败行为

失败保留已完成步骤，并报告实际残留状态。没有有效组合包声明的 profile 依赖仍可见、可删除，但不能启用。

| 失败操作 | 处理方式 |
|---|---|
| 安装：pnpm 执行或组合包校验失败 | 只尝试删除本次新增且能够明确识别的依赖，不恢复已有包。报告安装失败。 |
| 启用：保存选择项或加载失败 | 保留已安装的依赖和已保存的选择项。报告启用失败，允许修正、停用或卸载。 |
| 卸载：任一步失败 | 停在失败步骤，保留已完成的改动和待重试删除的依赖，报告卸载失败。不重新启用组合包。 |

pnpm 执行和组合包校验成功即完成安装，后续启用失败不撤销安装。卸载依次执行：从 `dsh.profile.bundles` 移除组合包、卸载运行时贡献、执行 `pnpm remove`。任一步失败都不继续执行后续步骤。

安装补偿清理只尝试一次。清理失败或无法明确识别新增依赖时，保留实际状态，同时报告原始失败、清理诊断及残留依赖，不递归撤销清理。清理范围仅限依赖和组合包选择项，不处理用户编写的 patch 配置、应用数据或诊断日志。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
