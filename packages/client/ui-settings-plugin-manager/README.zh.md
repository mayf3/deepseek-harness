---
description: "dsh Web 客户端设置里的插件管理标签页：经 pnpm 安装包、启停 bundle、重试失败的 bundle，并把行组合进全局用户层或某个 Agent 预设。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-plugin-manager

[English](README.md) | 中文

## 概述

`dsh-client-ui-settings-plugin-manager` 向 Web 设置的「插件」分区贡献**插件管理**标签页。该标签页在首次被选择时通过 `ctx.remote.plugins.list()` 读取 profile 的包、通过 `ctx.remote.pluginInventory.list()` 读取预设组合，并在每次操作之后、每个转发的 `plugins/changed` 事件之后重新读取，因此从 CLI 或另一个浏览器做出的改动无需手动刷新即可显示。页面只说两个名词但不把它们显示出来：*插件包*（bundle）整体启停、对所有会话生效；*插件*（插件模块）经**加入到…**加入某个预设或所有会话。**已安装**组为每个包列出一张卡片，带显示名与一句话描述；插件包带开关，插件带**加入到…**菜单，内置插件包带*内置*标记与锁定的开关，只有需重启或异常时卡片才打标签。卡片进入该包自己的页面：名称、一句话描述与开关；版本与来源；插件包的行以列表展示——一行计数，然后每行带自己的状态、记录在案的失败信息，以及外部插件包在实时应用补丁的 profile 上每行自己的开关；插件包改动的内置行；包声明的可加入模块，每个说明已加入到哪里并带自己的**加入到…**；以及**卸载**。entry id、模块名、种类与探针事实不出现在页面上。预设的组合不在这个标签页上：本包把它作为**能力**段贡献到 Agent 预设分区里该预设的详情页——同样的卡片，harness 模块按标签页字典命名，自己装的模块按 manifest 命名并带*本地*标记，每张卡片一个开关，用户添加的行带**删除**，段头有**添加**菜单。安装对话框接受包名、本地路径或 Git 地址，把 pnpm 输出收在失败时自动展开的折叠里，并按包用一句话说明结果。有依赖方的停用与每次卸载都要等待一次确认，确认框点名还在使用该包的地方。没有 profile runtime 时标签页声明自己不可用且不提供任何操作。

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

**添加**打开安装对话框。输入 pnpm 接受的写法——`dsh-better-sidebar@latest`、`/path/to/plugin`、Git 地址——并选择新装的插件包是否立即启用。对话框显示运行进度，pnpm 输出收在**查看安装日志**折叠里，运行失败时自动展开；运行进行中对话框不能关闭。pnpm 退出后，每个包一句话说明结果：插件包已安装并启用、插件包已安装等待开关、插件已安装可加入预设、不是 DSH 插件的包已被移除、行 id 与已安装插件包冲突的包已被移除——最后一种附宿主给出的原因。宿主因为另一个改动还在进行、或有会话正在运行而拒绝的安装或其他操作，会原样显示那条拒绝理由。

### 切换一个插件包

插件包的开关调用 `plugins.enable` 或 `plugins.disable`。在实时重载的 profile 上，树会在开关落定前重新组合；在下次启动才应用层变更的 profile 上，改动被报告为*需重启*，标签页会在横幅里点名每个这样的包直到重启。探针拒绝的插件包显示为*异常*，展开后可见探针的原因，且无法打开；组件启动失败的插件包在展开区提供**重试**，与**卸载**并排。内置插件包带锁定的开关。停用会先询问宿主它会搁置什么，没有依赖方时跳过确认。

### 切换插件包里的一行

包页面上行的开关以 profile 的全局用户层为目标调用 `plugins.setRowDisabled`：关闭往 profile 的 `cordis.patch.yml` 写入该行 id 的 `disabled: true`，打开再把这个键删掉。树随即重组，该行的宿主半区卸下或挂上，插件包其余部分照常运行；插件包自己的客户端 bundle 为每个组件挂载的浏览器半区要到页面重载才消失。开关只在立即生效的地方出现——已打开的外部插件包，且 profile 在运行中就应用补丁；内置插件包、已关闭的插件包，以及下次启动才应用补丁的 profile，其行只读列出。插件包自己关掉的行，无论是 `disabled: true` 的行还是 `!!js` 门，都带原因锁定，因为用户层只能拒绝。异常的行可以关掉；已被别的层占用 id 的行没有挂载任何东西，无从切换。超过十行的列表带一个按行 id 筛选的输入框。

### 把插件加入预设

插件卡片带**加入到…**，列出所有会话与每个预设；已加入的目标被标注并置灰，声明了多个可导入模块的包把目标嵌在各模块之下。选择后通过 `plugins.addRow` 把一行写进全局用户补丁文件或某个预设的补丁文件。预设的组合在 Agent 预设分区里该预设自己的详情页上管理，本包向那里贡献**能力**段：每行一张带开关的卡片，用户添加的行带**删除**，段头的**添加**菜单列出预设还没有的已安装模块。开关往该预设的用户补丁层写入 `disabled: true` 或再次删掉这个键——预设自己关掉的行保持锁定，因为该层只能拒绝。运行中与已停用由开关表达，卡片不为此打标签。没有声明 id 的行不能切换。

### 阅读失败

上一次操作的结果停在两组之上：重启提示、完成提示，或带宿主原因的失败——探针拒绝、被拒的重新组合、已被占用的行 id。可以关掉它，也可以让下一次操作替换它。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 注册

浏览器插件注册一个 id 为 `manage`、order 为 -10 的本地化 `settings.plugins.tab` 贡献，位于配置标签页之前；另注册一个 id 为 `plugins` 的 `settings.agentPreset.detail` 贡献——每个预设详情页的能力段，读同一个 store。注册使用 `ctx.slots.inject()`，因此能跟随标签 slot 的延迟声明、重新声明、本地化变化与 teardown，而无需 import 分区拥有方。预设名经共享的 `presetDisplayText` 纯函数叠在 [`ui-agent-preset`](../ui-agent-preset/README.zh.md) 的字典上解析。预设里的 harness 模块经标签页自己的字典解析显示名与一句话——`name.<slug>` 与 `desc.<slug>`，先按组合行 id 查（四个子代理行共用一个模块），再按去掉 `dsh-` 前缀的无 scope 模块名查——且只对 `@deepseek-ai/` scope 下的模块生效；第三方模块读取其安装包的 `dsh.title` 与 `description`，或可添加模块自己的标题。

### store

`PluginManagerController` 持有一份快照：读取状态、包、预设组、忙碌键、提示、安装对话框与待确认项。`load` 把并发读取折叠成一次在途读取加一次重跑，因此读取中途到达的失效不会丢失。每个操作在一个忙碌键下运行——包名，或行的 `<target>:<rowId>`——把被拒的应答转成带宿主代码与原因的提示，并且无论结果如何随后重新读取。插件的 `apply` 订阅 `plugins/changed` 与 `connection/reset` 以重载渲染过的标签页，订阅 `plugins/install-log` 以折叠 spec 与打开的运行匹配的块。

### 确认

`disable` 与 `uninstall` 打开确认框并询问 `plugins.dependents`；确认框此后已变化时丢弃这份应答。空应答的停用自行确认。对话框把每个依赖方说成人话——注入该包所提供服务的行按 harness 名称点名，引用该包的用户层行按包标题与所在层点名——确认按钮在应答到达前保持禁用。确认框守护的操作在打开时捕获，只经该按钮运行。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

这些页面覆盖设置分区、Remote 调用与宿主侧管理器。

- [ui-settings-plugins](../ui-settings-plugins/README.zh.md)——本标签页注册进的「插件」分区。
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

- **全局用户层的行不按包列出**——加入所有会话的行会在该包的**加入到…**菜单里标注该目标并出现在其依赖方里，而不在卡片上；移除它要走补丁文件或将来的行列表。
- **harness 模块的名字放在本标签页的字典里**——新的第一方 agent 面模块在补上 `name.<slug>` 与 `desc.<slug>` 之前按短模块名显示。
- **一次只能安装一个**——对话框运行一条 pnpm 命令；第二个 spec 要等第一个结束。
- **没有版本选择器**——spec 按 pnpm 接受的写法输入；标签页既不列出仓库版本也不提供升级。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变量：** 不发布 companion。本包拥有一个基于宿主事实的设置贡献。
