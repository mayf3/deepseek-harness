---
description: "dsh Web 客户端左侧栏「插件」入口背后的插件管理：经 pnpm 安装包、启停 bundle、重试失败的 bundle，并把行组合进全局用户层或某个 Agent 预设。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-plugin-manager

[English](README.md) | 中文

## 概述

使用 Web 左侧栏的**插件**入口可以按两组查看 profile 已安装的包——插件包整体开关、插件经**加入到…**加入某个预设或所有会话——打开插件包自己的页面来开关它的行并卸载它，也可以按包名、路径或 Git 地址安装包，并在一块终端里观看每次 pnpm 运行。有依赖方时与每次卸载都要确认。同一个 store 还把**能力**段贡献到每个预设的详情页；插件的配置仍留在设置的**插件**分区。

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

在左侧栏选择**插件**。插件激活期间不会读取 Remote——选择该入口时才挂载页面，页面再通过 `api-remotes` 读取包与预设组合。插件的配置仍在设置的**插件**分区。

### 安装一个包

**添加插件**打开安装对话框。输入 pnpm 接受的写法——`dsh-better-sidebar@latest`、`/path/to/plugin`、Git 地址——并选择新装的插件包是否立即启用。对话框把每条 pnpm 命令显示成一块终端——命令行、带颜色边跑边刷的输出、非零时的退出码——运行进行中对话框不能关闭。终端上方一行写明 pnpm 安装到的 profile 目录；运行完成后只剩**完成**一个动作，改动包名后对话框从头开始。pnpm 退出后，每个包一句话说明结果：插件包已安装并启用、插件包已安装等待开关、插件已安装可加入预设、不是 DSH 插件的包已被移除、行 id 与已安装插件包冲突的包已被移除——最后一种附宿主给出的原因。宿主因为另一个改动还在进行、或有会话正在运行而拒绝的安装或其他操作，会原样显示那条拒绝理由。

### 切换一个插件包

插件包的开关调用 `plugins.enable` 或 `plugins.disable`。在实时重载的 profile 上，树会在开关落定前重新组合；在下次启动才应用层变更的 profile 上，改动被报告为*需重启*，页面会在横幅里点名每个这样的包直到重启。探针拒绝的插件包显示为*异常*，展开后可见探针的原因，且无法打开；组件启动失败的插件包在展开区提供**重试**，与**卸载**并排。内置插件包带锁定的开关。停用会先询问宿主它会搁置什么，询问期间开关置灰，只有存在依赖方时才弹出确认框。

### 切换插件包里的一行

包页面上行的开关以 profile 的全局用户层为目标调用 `plugins.setRowDisabled`：关闭往 profile 的 `cordis.patch.yml` 写入该行 id 的 `disabled: true`，打开再把这个键删掉。树随即重组，该行的宿主半区卸下或挂上，插件包其余部分照常运行；插件包自己的客户端 bundle 为每个组件挂载的浏览器半区要到页面重载才消失。开关只在立即生效的地方出现——已打开的外部插件包，且 profile 在运行中就应用补丁；内置插件包、已关闭的插件包，以及下次启动才应用补丁的 profile，其行只读列出。插件包自己关掉的行，无论是 `disabled: true` 的行还是 `!!js` 门，都带原因锁定，因为用户层只能拒绝。异常的行可以关掉；已被别的层占用 id 的行没有挂载任何东西，无从切换。关闭一行前先向宿主询问有哪些行注入它提供的服务，询问期间开关置灰，有则弹出确认框点名它们；没有依赖方的行直接关闭，打开从不询问。超过十行的列表带一个按行 id 筛选的输入框。

### 把插件加入预设

插件卡片带**加入到…**，列出所有会话与每个预设；已加入的目标被标注并置灰，声明了多个可导入模块的包把目标嵌在各模块之下。选择后通过 `plugins.addRow` 把一行写进全局用户补丁文件或某个预设的补丁文件。预设的组合在 Agent 预设分区里该预设自己的详情页上管理，本包向那里贡献**能力**段：每行一张带开关的卡片，用户添加的行带**删除**，段头的**添加**菜单列出预设还没有的已安装模块。开关往该预设的用户补丁层写入 `disabled: true` 或再次删掉这个键——预设自己关掉的行保持锁定，因为该层只能拒绝。运行中与已停用由开关表达，卡片不为此打标签。没有声明 id 的行不能切换。

### 阅读失败

上一次操作留下的话停在两组之上：重启提示，或带宿主原因的失败——探针拒绝、被拒的重新组合、已被占用的行 id。可以关掉它，也可以让下一次操作替换它。等待另一行提供的服务的行——比如那一行被人关掉了——在行上和插件包标签上都读作*等待依赖*，不论是就地重组把 fiber 留在挂起状态，还是全新组合把这次等待记成了失败；红色的*异常*只留给真正的失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 注册

浏览器插件用同一个 id 把 `plugins` 面板注册两次：一个 order 为 0 的 `sidebar.panellist` 条目，其本地化标签由侧栏渲染、图标由本包提供，以及它打开的 `main` 键控条目——管理页面，根级作用域，不绑定任何 Session；另注册一个 id 为 `plugins` 的 `settings.agentPreset.detail` 贡献——每个预设详情页的能力段，读同一个 store。注册使用 `ctx.slots.inject()`，因此能跟随 slot 的延迟声明、重新声明、本地化变化与 teardown，而无需 import 侧栏或布局的拥有方。预设名经共享的 `presetDisplayText` 纯函数叠在 [`ui-agent-preset`](../ui-agent-preset/README.zh.md) 的字典上解析。预设里的 harness 模块经页面自己的字典解析显示名与一句话——`name.<slug>` 与 `desc.<slug>`，先按组合行 id 查（四个子代理行共用一个模块），再按去掉 `dsh-` 前缀的无 scope 模块名查——且只对 `@deepseek-ai/` scope 下的模块生效；第三方模块读取其安装包的 `dsh.title` 与 `description`，或可添加模块自己的标题。

### store

`PluginManagerController` 持有一份快照：读取状态、包、预设组、忙碌键、提示、安装对话框与待确认项。`load` 把并发读取折叠成一次在途读取加一次重跑，因此读取中途到达的失效不会丢失。每个操作在一个忙碌键下运行——包名，或行的 `<target>:<rowId>`——把被拒的应答转成带宿主代码与原因的提示，并且无论结果如何随后重新读取。插件的 `apply` 订阅 `plugins/changed` 与 `connection/reset` 以重载渲染过的页面，订阅 `plugins/install-log` 按 job 把块折进打开的安装的各次运行——`add` 运行与随后的移除运行一视同仁，因为宿主一次只跑一个变更。

### 确认

`disable` 与 `uninstall` 打开确认框并询问 `plugins.dependents`；确认框此后已变化时丢弃这份应答。空应答的停用自行确认。对话框把每个依赖方说成人话——注入该包所提供服务的行按 harness 名称点名，引用该包的用户层行按包标题与所在层点名——确认按钮在应答到达前保持禁用。确认框守护的操作在打开时捕获，只经该按钮运行。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

这些页面覆盖设置分区、Remote 调用与宿主侧管理器。

- [ui-sidebar](../ui-sidebar/README.zh.md)——「插件」入口注册进的面板列表；[ui-layout](../ui-layout/README.zh.md)——页面所占的 main slot。
- [api-remotes](../../api/remotes/README.zh.md)——`plugins.*` 与 `pluginInventory.list()` 背后的 Remote BFF 表面。
- [plugin-manager](../../host/plugin-manager/README.zh.md)——本页面驱动的宿主侧管理器。

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
- **harness 模块的名字放在本页面的字典里**——新的第一方 agent 面模块在补上 `name.<slug>` 与 `desc.<slug>` 之前按短模块名显示。
- **一次只能安装一个**——对话框运行一条 pnpm 命令；第二个 spec 要等第一个结束。
- **没有版本选择器**——spec 按 pnpm 接受的写法输入；页面既不列出仓库版本也不提供升级。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变量：** 不发布 companion。本包拥有一个侧栏面板与一个基于宿主事实的设置贡献。
