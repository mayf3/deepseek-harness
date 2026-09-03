---
description: "dsh Web 客户端设置里的插件管理标签页：经 pnpm 安装包、启停 bundle、重试失败的 bundle，并把行组合进全局用户层或某个 Agent 预设。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-plugin-manager

[English](README.md) | 中文

## 概述

`dsh-client-ui-settings-plugin-manager` 向 Web 设置的「插件」分区贡献**插件管理**标签页。该标签页在首次被选择时通过 `ctx.remote.plugins.list()` 读取 profile 的包、通过 `ctx.remote.pluginInventory.list()` 读取预设组合，并在每次操作之后、每个转发的 `plugins/changed` 事件之后重新读取，因此从 CLI 或另一个浏览器做出的改动无需手动刷新即可显示。全局组为每个包列出一张卡片，带信任、种类、阶段与状态标签；bundle 携带一个开关，把它放入或移出 profile 的层列表；展开的卡片显示它贡献的行及各行的阶段与失败、它覆盖的内置行、它声明可添加的模块——每个模块带一个列出全局层与每个预设的**添加到…**菜单——以及该包提供的重试与卸载操作。会话组显示选中预设的组合，每行一个开关，用户添加的行还有移除操作。安装对话框接受 npm 包名、本地路径或 git 地址，随 `plugins/install-log` 块到达流式显示 pnpm 输出，并报告这次运行新增了什么。有依赖方的停用与每次卸载都要等待一次已勾选确认，确认框列出其他行注入的服务与引用该包的用户层行。没有 profile runtime 时标签页声明自己不可用且不提供任何操作。

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

打开设置中的「插件」分区并选择**插件管理**标签页。插件激活期间不会读取 Remote——选择该标签页时才挂载组件，组件再通过 `api-remotes` 读取包与预设组合。

### 安装一个包

**添加插件**打开安装对话框。输入 pnpm 接受的写法——`dsh-better-sidebar@latest`、`/path/to/plugin`、git 地址——并选择新装的 bundle 是否立即启用。对话框流式显示运行输出，pnpm 退出后列出这次运行新增的依赖；非零退出会保留输出供阅读。运行进行中对话框不能关闭。

### 切换一个 bundle

bundle 的开关调用 `plugins.enable` 或 `plugins.disable`。在实时重载的 profile 上，树会在开关落定前重新组合；在下次启动才应用层变更的 profile 上，改动被报告为待生效，标签页会在横幅里点名每个这样的包直到重启。内置 bundle 的开关被锁定；探针拒绝的 bundle 无法打开并显示探针的原因。停用会先询问宿主它会搁置什么，没有依赖方时跳过确认。

### 组合行

展开的卡片列出该包声明可添加的模块；**添加到…**通过 `plugins.addRow` 把一行写进全局用户补丁文件或某个预设的补丁文件。会话组的预设切换器显示某个预设的组合：行的开关往该预设的用户补丁层写入 `disabled: true` 或再次删掉这个键，用户添加的行可以移除。没有声明 id 的行不能在这里切换。

### 阅读失败

上一次操作的结果停在两组之上：重启提示、完成提示，或带宿主原因的失败——探针拒绝、被拒的重新组合、已被占用的行 id。可以关掉它，也可以让下一次操作替换它。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 注册

浏览器插件注册一个 id 为 `manage`、order 为 5 的本地化 `settings.plugins.tab` 贡献，位于配置标签页与只读列表之间。注册使用 `ctx.slots.inject()`，因此能跟随标签 slot 的延迟声明、重新声明、本地化变化与 teardown，而无需 import 分区拥有方。预设名与清单标签页一样，经共享的 `presetDisplayText` 纯函数叠在 [`ui-agent-preset`](../ui-agent-preset/README.zh.md) 的字典上解析。

### store

`PluginManagerController` 持有一份快照：读取状态、包、预设组、忙碌键、提示、安装对话框与待确认项。`load` 把并发读取折叠成一次在途读取加一次重跑，因此读取中途到达的失效不会丢失。每个操作在一个忙碌键下运行——包名，或行的 `<target>:<rowId>`——把被拒的应答转成带宿主代码与原因的提示，并且无论结果如何随后重新读取。插件的 `apply` 订阅 `plugins/changed` 与 `connection/reset` 以重载渲染过的标签页，订阅 `plugins/install-log` 以折叠 spec 与打开的运行匹配的块。

### 确认

`disable` 与 `uninstall` 打开确认框并询问 `plugins.dependents`；确认框此后已变化时丢弃这份应答。空应答的停用自行确认。确认框守护的操作在打开时捕获，只经**继续**运行。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

这些页面覆盖设置分区、Remote 调用与宿主侧管理器。

- [ui-settings-plugins](../ui-settings-plugins/README.zh.md)——本标签页注册进的「插件」分区。
- [ui-settings-plugin-inventory](../ui-settings-plugin-inventory/README.zh.md)——本标签页旁边的只读列表。
- [api-remotes](../../api/remotes/README.zh.md)——`plugins.*` 与 `pluginInventory.list()` 背后的 Remote BFF 表面。
- [plugin-manager](../../host/plugin-manager/README.zh.md)——本标签页驱动的宿主侧管理器。

-----

<a id="model-experience"></a>
## 模型体验

无，本包是浏览器侧的管理表面，不注册任何面向模型的内容。

#### KV Cache 影响

无；本包既不组装也不发送 provider 请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定管理视图的范围；它们是本包当前的约束。

- **全局用户层的行不按包列出**——添加到全局层的行出现在只读列表与该包的依赖方里，而不在包卡片上；移除它要走补丁文件或将来的行列表。
- **一次只能安装一个**——对话框运行一条 pnpm 命令；第二个 spec 要等第一个结束。
- **没有版本选择器**——spec 按 pnpm 接受的写法输入；标签页既不列出仓库版本也不提供升级。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变量：** 不发布 companion。本包拥有一个基于宿主事实的设置贡献。
