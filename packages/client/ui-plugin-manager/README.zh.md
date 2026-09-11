---
description: "dsh Web 客户端左侧栏「插件」入口背后的插件管理：经 pnpm 安装包、启停 bundle、重试失败的 bundle，并把行组合进全局用户层或某个 Agent 预设。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-plugin-manager

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

**添加插件**接受 pnpm 包描述、本地路径或 Git URL。对话框显示命令、实时输出和完成结果，在安装期间保持打开。新组合包可以立即启用。未声明入口的包保持已安装；无效或冲突的组合包声明可能被拒绝，并显示宿主原因。安装成功不代表模块一定能够激活。

### 切换一个插件包

组合包开关改变其启用层选择。实时 profile 在操作完成前重组；仅启动时生效的 profile 显示重启提示。运行失败会保留成功组件和组合包的启用状态，并在详情页提供**重试**与**卸载**。组合包声明不可读时无法启用。内置组合包的开关被锁定。停用会先检查依赖方，必要时要求确认。

### 切换插件包里的一行

包页面上行的开关以 profile 的全局用户层为目标调用 `plugins.setRowDisabled`：关闭往 profile 的 `cordis.patch.yml` 写入该行 id 的 `disabled: true`，打开再把这个键删掉。树随即重组，该行的宿主半区卸下或挂上，插件包其余部分照常运行；插件包自己的客户端 bundle 为每个组件挂载的浏览器半区要到页面重载才消失。开关只在立即生效的地方出现——已打开的外部插件包，且 profile 在运行中就应用补丁；内置插件包、已关闭的插件包，以及下次启动才应用补丁的 profile，其行只读列出。插件包自己关掉的行，无论是 `disabled: true` 的行还是 `!!js` 门，都带原因锁定，因为用户层只能拒绝。异常的行可以关掉；已被别的层占用 id 的行没有挂载任何东西，无从切换。关闭一行前先向宿主询问有哪些行注入它提供的服务，询问期间开关置灰，有则弹出确认框点名它们；没有依赖方的行直接关闭，打开从不询问。超过十行的列表带一个按行 id 筛选的输入框。

### 把插件加入预设

有显式插件声明的包为每个声明入口提供**加入到…**，包括已声明的主入口。菜单标记已加入的目标。添加会写入全局或预设用户 patch，不进行导入预检。未识别到声明的包没有添加操作，但仍可卸载。预设行在预设详情页的**能力**区域管理：开关写入或删除用户的 `disabled: true` 覆盖，**删除**移除用户插入。

### 阅读失败

页面分别展示启用选择、运行阶段和当前问题。缺少服务显示为*等待依赖*。无效配置后旧实例仍在运行的行显示*运行中，但最近更新失败*及实际错误。组合包详情还标识其 patch 影响的其他组件的问题，保留原归属。运行变化在 Loader 和 profile 重组完成后刷新页面。操作被拒绝时保留宿主给出的原因。

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
